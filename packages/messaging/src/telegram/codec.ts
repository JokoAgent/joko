import { MessagingTransportError, type MessagingAddress } from "../types.js";

const MESSAGE_SEPARATOR = "|";

export function encodeTelegramMessageId(chatId: string, messageId: string): string {
  assertCoordinate(chatId);
  assertCoordinate(messageId);
  return `${chatId}${MESSAGE_SEPARATOR}${messageId}`;
}

export function decodeTelegramMessageId(value: string): { readonly chatId: string; readonly messageId: string } {
  const parts = value.split(MESSAGE_SEPARATOR);
  if (parts.length !== 2 || parts[0] === undefined || parts[1] === undefined) {
    throw invalidCoordinate();
  }
  assertCoordinate(parts[0]);
  assertCoordinate(parts[1]);
  return { chatId: parts[0], messageId: parts[1] };
}

export function telegramAddress(input: {
  readonly connectionId: string;
  readonly chatId: string;
  readonly chatType: "private" | "group" | "supergroup" | "channel";
  readonly threadId?: string | null;
}): MessagingAddress {
  assertCoordinate(input.connectionId);
  assertCoordinate(input.chatId);
  return {
    channel: "telegram",
    connectionId: input.connectionId,
    providerConversationId: input.chatId,
    providerThreadId: input.threadId?.trim() || null,
    conversationKind: input.chatType === "private"
      ? "direct"
      : input.chatType === "channel" ? "channel" : "group"
  };
}

function assertCoordinate(value: string): void {
  if (value.length === 0 || value.length > 256 || value.includes(MESSAGE_SEPARATOR)) {
    throw invalidCoordinate();
  }
}

function invalidCoordinate(): MessagingTransportError {
  return new MessagingTransportError("invalid_input", "Invalid Telegram coordinate.", {
    retryable: false,
    effect: "none"
  });
}
