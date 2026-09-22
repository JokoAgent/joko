import type { MessagingIgnoredInbound, MessagingInboundMessage, MessagingSpeaker } from "../types.js";
import { decodeWeChatMessage, weChatAddress, weChatAttachment } from "./codec.js";
import type { WeChatNormalizationResult, WeChatRawMessage, WeChatTransientMedia } from "./model.js";

export const WECHAT_DEFAULT_MAXIMUM_MESSAGE_AGE_MS = 60 * 60_000;
export const WECHAT_MAXIMUM_ATTACHMENTS = 4;

export interface WeChatNormalizationOptions {
  readonly connectionId: string;
  readonly botId: string;
  readonly ownerUserId: string;
  readonly now?: () => number;
  readonly maximumMessageAgeMs?: number;
}

export function normalizeWeChatUpdates(
  source: readonly WeChatRawMessage[],
  options: WeChatNormalizationOptions
): WeChatNormalizationResult {
  const now = options.now?.() ?? Date.now();
  const maximumAge = options.maximumMessageAgeMs ?? WECHAT_DEFAULT_MAXIMUM_MESSAGE_AGE_MS;
  const events: MessagingInboundMessage[] = [];
  const ignored: MessagingIgnoredInbound[] = [];
  const privateContexts: WeChatNormalizationResult["privateContexts"][number][] = [];
  const seen = new Set<string>();
  for (const raw of source) {
    const decoded = decodeWeChatMessage(raw);
    const fallbackRequest = rawRequestId(raw);
    if (decoded === null) {
      ignored.push(ignoredEntry(fallbackRequest, "invalid", raw.from_user_id ?? null));
      continue;
    }
    const requestId = `wechat:${decoded.messageId}`;
    if (seen.has(decoded.messageId)) {
      ignored.push(ignoredEntry(requestId, "duplicate", decoded.senderId));
      continue;
    }
    seen.add(decoded.messageId);
    if (decoded.occurredAt - now > 5 * 60_000 || now - decoded.occurredAt > maximumAge) {
      ignored.push(ignoredEntry(requestId, "stale", decoded.senderId));
      continue;
    }
    const address = weChatAddress(options.connectionId, decoded.senderId);
    const speaker: MessagingSpeaker = {
      providerUserId: decoded.senderId,
      displayName: "WeChat user",
      username: null,
      isBot: false,
      isOwner: decoded.senderId === options.ownerUserId
    };
    const attachments = decoded.media.slice(0, WECHAT_MAXIMUM_ATTACHMENTS).map((media, index) => weChatAttachment(decoded.messageId, index, media));
    const unsupported = decoded.media.length > WECHAT_MAXIMUM_ATTACHMENTS
      ? [...decoded.unsupported, { code: "attachment_limit", label: `${decoded.media.length - WECHAT_MAXIMUM_ATTACHMENTS} additional attachments were not retained.` }]
      : decoded.unsupported;
    if (decoded.text === "" && attachments.length === 0 && unsupported.length === 0) {
      ignored.push(ignoredEntry(requestId, "service_message", decoded.senderId));
      continue;
    }
    events.push({
      kind: "message",
      providerRequestIds: [requestId],
      messageId: decoded.messageId,
      address,
      speaker,
      occurredAt: decoded.occurredAt,
      text: decoded.text,
      ambient: false,
      protectedContent: false,
      attachments,
      unsupported,
      replyContext: decoded.replyContext
    });
    privateContexts.push({
      messageId: decoded.messageId,
      providerConversationId: decoded.senderId,
      contextToken: decoded.contextToken
    });
  }
  return { events, interactionReplyCandidates: [], groupObservations: [], ignored, privateContexts };
}

export function transientMediaFor(raw: WeChatRawMessage): readonly WeChatTransientMedia[] {
  return decodeWeChatMessage(raw)?.media ?? [];
}

function ignoredEntry(
  providerRequestId: string,
  reason: MessagingIgnoredInbound["reason"],
  providerUserId: string | null
): MessagingIgnoredInbound {
  return { providerRequestId, reason, providerConversationId: providerUserId, providerUserId };
}

function rawRequestId(raw: WeChatRawMessage): string {
  const value = raw.client_id ?? raw.message_id ?? raw.seq ?? "invalid";
  return `wechat:${String(value).slice(0, 512)}`;
}
