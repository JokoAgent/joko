import { Buffer } from "node:buffer";

import type { MessagingAddress } from "../types.js";
import type { FeishuService } from "./model.js";

const ATTACHMENT_PREFIX = "feishu-attachment:";

export function feishuAddress(input: {
  readonly service: FeishuService;
  readonly connectionId: string;
  readonly providerConversationId: string;
  readonly providerThreadId?: string | null;
  readonly group: boolean;
}): MessagingAddress {
  return {
    channel: input.service,
    connectionId: requiredFeishuIdentifier(input.connectionId, "connection", 256),
    providerConversationId: requiredFeishuIdentifier(input.providerConversationId, "conversation", 512),
    providerThreadId: input.providerThreadId === undefined || input.providerThreadId === null
      ? null
      : requiredFeishuIdentifier(input.providerThreadId, "thread", 512),
    conversationKind: input.group ? "group" : "direct"
  };
}

export function feishuAttachmentCoordinate(messageId: string, index: number): string {
  if (!Number.isSafeInteger(index) || index < 0 || index > 100) throw new Error("Feishu attachment index is invalid.");
  const encoded = Buffer.from(requiredFeishuIdentifier(messageId, "message", 512), "utf8").toString("base64url");
  return `${ATTACHMENT_PREFIX}${encoded}:${index}`;
}

export function requiredFeishuIdentifier(value: string, label: string, maximum = 512): string {
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > maximum || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error(`Feishu ${label} identifier is invalid.`);
  }
  return normalized;
}
