import { MessagingTransportError, type MessagingAddress } from "../types.js";

const ATTACHMENT_SEPARATOR = "/";
const SNOWFLAKE_PATTERN = /^[1-9][0-9]{16,19}$/u;

export function discordSnowflake(value: string, label = "identifier"): string {
  if (!SNOWFLAKE_PATTERN.test(value)) throw invalidInput(`Invalid Discord ${label}.`);
  return value;
}

export function discordAddress(input: {
  readonly connectionId: string;
  readonly channel: { readonly id: string; readonly type: number; readonly guild_id?: string; readonly parent_id?: string | null };
}): MessagingAddress {
  const connectionId = requiredIdentifier(input.connectionId, "connection");
  const channelId = discordSnowflake(input.channel.id, "channel identifier");
  if (input.channel.type === 1) {
    return {
      channel: "discord",
      connectionId,
      providerConversationId: channelId,
      providerThreadId: null,
      conversationKind: "direct"
    };
  }
  if (isDiscordThreadType(input.channel.type)) {
    const parent = discordSnowflake(input.channel.parent_id ?? "", "thread parent identifier");
    return {
      channel: "discord",
      connectionId,
      providerConversationId: parent,
      providerThreadId: channelId,
      conversationKind: "channel"
    };
  }
  return {
    channel: "discord",
    connectionId,
    providerConversationId: channelId,
    providerThreadId: null,
    conversationKind: "channel"
  };
}

export function discordAttachmentCoordinate(input: {
  readonly channelId: string;
  readonly messageId: string;
  readonly attachmentId: string;
}): string {
  return [input.channelId, input.messageId, input.attachmentId]
    .map((part) => discordSnowflake(part))
    .join(ATTACHMENT_SEPARATOR);
}

export function decodeDiscordAttachmentCoordinate(value: string): {
  readonly channelId: string;
  readonly messageId: string;
  readonly attachmentId: string;
} {
  const parts = value.split(ATTACHMENT_SEPARATOR);
  if (parts.length !== 3) throw invalidInput("Invalid Discord attachment coordinate.");
  return {
    channelId: discordSnowflake(parts[0] ?? "", "attachment channel identifier"),
    messageId: discordSnowflake(parts[1] ?? "", "attachment message identifier"),
    attachmentId: discordSnowflake(parts[2] ?? "", "attachment identifier")
  };
}

export function isDiscordThreadType(type: number): boolean {
  return type === 10 || type === 11 || type === 12;
}

export function actualDiscordChannelId(address: MessagingAddress): string {
  if (address.channel !== "discord") throw invalidInput("Discord address belongs to another channel.");
  return discordSnowflake(address.providerThreadId ?? address.providerConversationId, "channel identifier");
}

function requiredIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 256 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw invalidInput(`Invalid Discord ${label}.`);
  }
  return normalized;
}

function invalidInput(message: string): MessagingTransportError {
  return new MessagingTransportError("invalid_input", message, { retryable: false, effect: "none" });
}
