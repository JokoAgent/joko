import { Buffer } from "node:buffer";

import type { MessagingAddress } from "../types.js";

const ATTACHMENT_PREFIX = "wecom-attachment:";

export function weComAddress(input: {
  readonly connectionId: string;
  readonly providerConversationId: string;
  readonly group: boolean;
}): MessagingAddress {
  return {
    channel: "wecom",
    connectionId: requiredWeComIdentifier(input.connectionId, "connection", 256),
    providerConversationId: requiredWeComIdentifier(input.providerConversationId, "conversation", 512),
    providerThreadId: null,
    conversationKind: input.group ? "group" : "direct"
  };
}

export function weComAttachmentCoordinate(messageId: string, index: number): string {
  if (!Number.isSafeInteger(index) || index < 0 || index > 100) {
    throw new Error("WeCom attachment index is invalid.");
  }
  const encoded = Buffer.from(requiredWeComIdentifier(messageId, "message", 512), "utf8").toString("base64url");
  return `${ATTACHMENT_PREFIX}${encoded}:${index}`;
}

export function requiredWeComIdentifier(value: string, label: string, maximum = 512): string {
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > maximum || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error(`WeCom ${label} identifier is invalid.`);
  }
  return normalized;
}
