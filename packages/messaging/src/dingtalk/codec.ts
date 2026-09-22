import { Buffer } from "node:buffer";

import type { MessagingAddress } from "../types.js";

const ATTACHMENT_PREFIX = "dingtalk-attachment:";

export function dingTalkAddress(input: {
  readonly connectionId: string;
  readonly providerConversationId: string;
  readonly group: boolean;
}): MessagingAddress {
  return {
    channel: "dingtalk",
    connectionId: requiredIdentifier(input.connectionId, "connection"),
    providerConversationId: requiredProviderIdentifier(input.providerConversationId, "conversation"),
    providerThreadId: null,
    conversationKind: input.group ? "group" : "direct"
  };
}

export function dingTalkAttachmentCoordinate(messageId: string, index: number): string {
  const encodedMessage = Buffer.from(requiredProviderIdentifier(messageId, "message"), "utf8").toString("base64url");
  if (!Number.isSafeInteger(index) || index < 0 || index > 100) throw new Error("DingTalk attachment index is invalid.");
  return `${ATTACHMENT_PREFIX}${encodedMessage}:${index}`;
}

export function requiredDingTalkProviderId(value: string, label: string): string {
  return requiredProviderIdentifier(value, label);
}

function requiredIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(normalized)) {
    throw new Error(`DingTalk ${label} identifier is invalid.`);
  }
  return normalized;
}

function requiredProviderIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 512 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error(`DingTalk ${label} identifier is invalid.`);
  }
  return normalized;
}
