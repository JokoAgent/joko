import type {
  MessagingGroupObservation,
  MessagingIgnoredInbound,
  MessagingInboundAttachment,
  MessagingInboundEvent,
  MessagingInboundInteraction,
  MessagingInboundMessage,
  MessagingReplyContext,
  MessagingSpeaker,
  MessagingUnsupportedPart
} from "../types.js";
import {
  discordAddress,
  discordAttachmentCoordinate,
  discordSnowflake,
  isDiscordThreadType
} from "./codec.js";
import type {
  DiscordAttachment,
  DiscordChannel,
  DiscordGatewayUpdate,
  DiscordInteraction,
  DiscordMessage,
  DiscordUser
} from "./model.js";

export const DISCORD_DEFAULT_MAXIMUM_MESSAGE_AGE_MS = 24 * 60 * 60 * 1_000;
export const DISCORD_MAXIMUM_INBOUND_FILE_BYTES = 50 * 1024 * 1024;

export interface DiscordBotIdentity {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
}

export interface DiscordNormalizationOptions {
  readonly connectionId: string;
  readonly ownerUserId: string;
  readonly ownerConversationId: string;
  readonly bot: DiscordBotIdentity;
  /** Only explicit guild/root-channel rules authorize guild traffic. */
  readonly groupActivation: Readonly<Record<string, "mention" | "always" | "disabled">>;
  readonly now?: () => number;
  readonly maximumMessageAgeMs?: number;
}

export interface DiscordNormalizationResult {
  readonly events: readonly MessagingInboundEvent[];
  readonly groupObservations: readonly MessagingGroupObservation[];
  readonly ignored: readonly MessagingIgnoredInbound[];
}

export function discordGroupRuleKey(guildId: string, channelId: string): string {
  return `${discordSnowflake(guildId, "guild identifier")}/${discordSnowflake(channelId, "channel identifier")}`;
}

export function normalizeDiscordUpdates(
  updates: readonly DiscordGatewayUpdate[],
  options: DiscordNormalizationOptions
): DiscordNormalizationResult {
  const now = options.now?.() ?? Date.now();
  const maximumAge = options.maximumMessageAgeMs ?? DISCORD_DEFAULT_MAXIMUM_MESSAGE_AGE_MS;
  const events: MessagingInboundEvent[] = [];
  const groupObservations: MessagingGroupObservation[] = [];
  const ignored: MessagingIgnoredInbound[] = [];
  const seen = new Set<string>();

  for (const update of [...updates].sort((left, right) => left.sequence - right.sequence)) {
    const identity = update.eventType === "MESSAGE_CREATE"
      ? update.message?.id
      : update.interaction?.id;
    const requestId = identity === undefined
      ? `discord:gateway:${String(update.sequence)}`
      : update.eventType === "MESSAGE_CREATE" ? `discord:message:${identity}` : `discord:interaction:${identity}`;
    if (!Number.isSafeInteger(update.sequence) || update.sequence < 0 || identity === undefined) {
      ignored.push(ignoredEntry(requestId, "invalid", null, null));
      continue;
    }
    if (seen.has(requestId)) {
      ignored.push(ignoredEntry(requestId, "duplicate", providerConversationId(update), providerUserId(update)));
      continue;
    }
    seen.add(requestId);

    try {
      if (update.eventType === "MESSAGE_CREATE" && update.message !== undefined) {
        const observation = groupObservation(update.message, update.channel, options);
        if (observation !== null) groupObservations.push(observation);
        const result = normalizeMessage(update.message, update.channel, options, now, maximumAge);
        if (result.event !== null) events.push(result.event);
        if (result.ignored !== null) ignored.push(result.ignored);
      } else if (update.eventType === "INTERACTION_CREATE" && update.interaction !== undefined) {
        const result = normalizeInteraction(update.interaction, update.channel, options, now, maximumAge);
        if (result.event !== null) events.push(result.event);
        if (result.ignored !== null) ignored.push(result.ignored);
      } else {
        ignored.push(ignoredEntry(requestId, "unsupported_update", null, null));
      }
    } catch {
      ignored.push(ignoredEntry(requestId, "invalid", providerConversationId(update), providerUserId(update)));
    }
  }
  return { events, groupObservations, ignored };
}

function normalizeMessage(
  message: DiscordMessage,
  channel: DiscordChannel,
  options: DiscordNormalizationOptions,
  now: number,
  maximumAge: number
): { readonly event: MessagingInboundMessage | null; readonly ignored: MessagingIgnoredInbound | null } {
  const requestId = `discord:message:${message.id}`;
  discordSnowflake(message.id, "message identifier");
  discordSnowflake(message.author.id, "user identifier");
  if (message.author.bot === true || message.author.id === options.bot.id) {
    return { event: null, ignored: ignoredEntry(requestId, "service_message", channel.id, message.author.id) };
  }
  const occurredAt = timestampOf(message.timestamp);
  if (isStale(occurredAt, now, maximumAge)) {
    return { event: null, ignored: ignoredEntry(requestId, "stale", channel.id, message.author.id) };
  }
  const authorization = authorizedAddress(channel, message.guild_id, options);
  if (authorization === null) {
    return { event: null, ignored: ignoredEntry(requestId, "unsupported_chat", channel.id, message.author.id) };
  }
  const { address, activation } = authorization;
  if (address.conversationKind === "direct" && message.author.id !== options.ownerUserId) {
    return { event: null, ignored: ignoredEntry(requestId, "unauthorized", channel.id, message.author.id) };
  }

  const parts = collectParts(message);
  let text = message.content ?? "";
  let ambient = false;
  if (address.conversationKind !== "direct") {
    if (activation === "disabled") {
      return { event: null, ignored: ignoredEntry(requestId, "unaddressed", channel.id, message.author.id) };
    }
    const owner = message.author.id === options.ownerUserId;
    let trigger = discordGroupTrigger(message, options.bot);
    if (trigger === null && owner && isBareCommand(text)) trigger = text.trim();
    if (trigger === null && activation === "always" && (text.trim() !== "" || parts.attachments.length > 0)) {
      trigger = text.trim();
      ambient = true;
    }
    if (trigger === null) {
      return { event: null, ignored: ignoredEntry(requestId, "unaddressed", channel.id, message.author.id) };
    }
    if (/^\s*[/!]/u.test(trigger) && (!owner || ambient)) {
      return { event: null, ignored: ignoredEntry(requestId, "unauthorized", channel.id, message.author.id) };
    }
    text = trigger;
  }
  if (text.trim() === "" && parts.attachments.length === 0 && parts.unsupported.length === 0) {
    return { event: null, ignored: ignoredEntry(requestId, "service_message", channel.id, message.author.id) };
  }
  return {
    event: {
      kind: "message",
      providerRequestIds: [requestId],
      messageId: message.id,
      address,
      speaker: speakerOf(message.author, options.ownerUserId),
      occurredAt,
      text,
      ambient,
      protectedContent: false,
      attachments: parts.attachments,
      unsupported: parts.unsupported,
      replyContext: replyContextOf(message)
    },
    ignored: null
  };
}

function normalizeInteraction(
  interaction: Omit<DiscordInteraction, "token">,
  channel: DiscordChannel,
  options: DiscordNormalizationOptions,
  now: number,
  maximumAge: number
): { readonly event: MessagingInboundInteraction | null; readonly ignored: MessagingIgnoredInbound | null } {
  const requestId = `discord:interaction:${interaction.id}`;
  const user = interaction.member?.user ?? interaction.user;
  const message = interaction.message;
  const customId = interaction.data?.custom_id;
  if (
    interaction.type !== 3 || interaction.data?.component_type !== 2 || user === undefined || message === undefined ||
    typeof customId !== "string" || customId.length === 0 || new TextEncoder().encode(customId).byteLength > 100
  ) {
    return { event: null, ignored: ignoredEntry(requestId, "invalid", interaction.channel_id ?? null, user?.id ?? null) };
  }
  discordSnowflake(interaction.id, "interaction identifier");
  discordSnowflake(message.id, "message identifier");
  discordSnowflake(user.id, "user identifier");
  const occurredAt = snowflakeTimestamp(interaction.id);
  if (isStale(occurredAt, now, maximumAge)) {
    return { event: null, ignored: ignoredEntry(requestId, "stale", channel.id, user.id) };
  }
  const authorization = authorizedAddress(channel, interaction.guild_id, options);
  if (authorization === null || authorization.activation === "disabled") {
    return { event: null, ignored: ignoredEntry(requestId, "unsupported_chat", channel.id, user.id) };
  }
  if (user.id !== options.ownerUserId) {
    return { event: null, ignored: ignoredEntry(requestId, "unauthorized", channel.id, user.id) };
  }
  return {
    event: {
      kind: "interaction",
      providerRequestIds: [requestId],
      interactionId: interaction.id,
      messageId: message.id,
      address: authorization.address,
      speaker: speakerOf(user, options.ownerUserId),
      actionValue: customId,
      occurredAt
    },
    ignored: null
  };
}

function authorizedAddress(
  channel: DiscordChannel,
  fallbackGuildId: string | undefined,
  options: DiscordNormalizationOptions
): {
  readonly address: ReturnType<typeof discordAddress>;
  readonly activation: "mention" | "always" | "disabled" | null;
} | null {
  const address = discordAddress({ connectionId: options.connectionId, channel });
  if (channel.type === 1) {
    return channel.id === options.ownerConversationId ? { address, activation: null } : null;
  }
  if (!isSupportedGuildType(channel.type)) return null;
  const guildId = channel.guild_id ?? fallbackGuildId;
  if (guildId === undefined) return null;
  const rootId = isDiscordThreadType(channel.type) ? channel.parent_id : channel.id;
  if (rootId === undefined || rootId === null) return null;
  const activation = options.groupActivation[discordGroupRuleKey(guildId, rootId)];
  return activation === undefined ? null : { address, activation };
}

function groupObservation(
  message: DiscordMessage,
  channel: DiscordChannel,
  options: DiscordNormalizationOptions
): MessagingGroupObservation | null {
  if (message.author.bot === true || message.author.id === options.bot.id || channel.type === 1) return null;
  const authorization = authorizedAddress(channel, message.guild_id, options);
  if (authorization === null || authorization.activation === "disabled") return null;
  const parts = collectParts(message);
  return {
    address: authorization.address,
    messageId: discordSnowflake(message.id, "message identifier"),
    speaker: speakerOf(message.author, options.ownerUserId),
    occurredAt: timestampOf(message.timestamp),
    text: message.content ?? "",
    attachmentNames: parts.attachments.map((attachment) => attachment.fileName)
  };
}

function collectParts(message: DiscordMessage): {
  readonly attachments: readonly MessagingInboundAttachment[];
  readonly unsupported: readonly MessagingUnsupportedPart[];
} {
  const attachments: MessagingInboundAttachment[] = [];
  const unsupported: MessagingUnsupportedPart[] = [];
  for (const attachment of message.attachments ?? []) {
    const parsed = normalizeAttachment(message, attachment);
    if ("unsupported" in parsed) unsupported.push(parsed.unsupported);
    else attachments.push(parsed.attachment);
  }
  for (const sticker of message.sticker_items ?? []) {
    unsupported.push({ code: "sticker", label: sanitizeLabel(sticker.name || "Sticker") });
  }
  return { attachments, unsupported };
}

function normalizeAttachment(
  message: DiscordMessage,
  attachment: DiscordAttachment
): { readonly attachment: MessagingInboundAttachment } | { readonly unsupported: MessagingUnsupportedPart } {
  discordSnowflake(attachment.id, "attachment identifier");
  if (!Number.isSafeInteger(attachment.size) || attachment.size < 0) {
    return { unsupported: { code: "invalid_attachment", label: "Invalid Discord attachment" } };
  }
  const fileName = sanitizeFileName(attachment.filename);
  if (attachment.size > DISCORD_MAXIMUM_INBOUND_FILE_BYTES) {
    return { unsupported: { code: "oversize", label: `${fileName} exceeds Discord's download limit.` } };
  }
  const mimeType = normalizeMime(attachment.content_type);
  if (mimeType?.startsWith("audio/") === true) {
    return { unsupported: { code: "audio", label: fileName } };
  }
  if (mimeType?.startsWith("video/") === true) {
    return { unsupported: { code: "video", label: fileName } };
  }
  return {
    attachment: {
      providerFileId: discordAttachmentCoordinate({
        channelId: message.channel_id,
        messageId: message.id,
        attachmentId: attachment.id
      }),
      providerUniqueFileId: attachment.id,
      kind: mimeType?.startsWith("image/") === true ? "image" : "file",
      fileName,
      mimeType,
      byteLength: attachment.size
    }
  };
}

export function discordGroupTrigger(message: DiscordMessage, bot: DiscordBotIdentity): string | null {
  const source = message.content ?? "";
  const mentioned = message.mentions?.some((user) => user.id === bot.id) === true
    || new RegExp(`<@!?${escapeRegExp(bot.id)}>`).test(source);
  const replied = message.referenced_message?.author.id === bot.id;
  if (!mentioned && !replied) {
    const summon = displayNameSummon(source, bot.displayName);
    return summon;
  }
  return source.replace(new RegExp(`<@!?${escapeRegExp(bot.id)}>`, "gu"), " ").replace(/[ \t]{2,}/gu, " ").trim();
}

function replyContextOf(message: DiscordMessage): MessagingReplyContext | null {
  const replied = message.referenced_message;
  if (replied === undefined || replied === null) return null;
  let text = replied.content ?? "";
  const attachmentCount = replied.attachments?.length ?? 0;
  if (text === "") {
    const first = replied.attachments?.[0];
    if (first !== undefined) text = `[Attachment: ${sanitizeFileName(first.filename)}]`;
    else if ((replied.sticker_items?.length ?? 0) > 0) text = "[Sticker]";
    else return null;
  }
  return {
    providerMessageId: discordSnowflake(replied.id, "reply message identifier"),
    author: displayNameOf(replied.author),
    text,
    isBot: replied.author.bot === true,
    attachmentCount
  };
}

function speakerOf(user: DiscordUser, ownerUserId: string): MessagingSpeaker {
  return {
    providerUserId: discordSnowflake(user.id, "user identifier"),
    displayName: displayNameOf(user),
    username: user.username.trim() || null,
    isBot: user.bot === true,
    isOwner: user.id === ownerUserId
  };
}

function displayNameOf(user: DiscordUser): string {
  return user.global_name?.trim() || user.username.trim() || user.id;
}

function displayNameSummon(source: string, displayName: string): string | null {
  const name = displayName.trim();
  if (name.length < 2) return null;
  const escaped = escapeRegExp(name);
  const separator = "[\\s,，。:：、!！?？~〜]";
  const atPattern = new RegExp(`@${escaped}(?![\\p{L}\\p{N}_])`, "giu");
  const leadPattern = new RegExp(`^\\s*${escaped}(?=$|${separator})`, "iu");
  let stripped = source.replace(atPattern, " ");
  if (stripped === source) {
    if (!leadPattern.test(source)) return null;
    stripped = source.replace(leadPattern, "").replace(new RegExp(`^${separator}+`, "u"), "");
  }
  return stripped.replace(/[ \t]{2,}/gu, " ").trim();
}

function timestampOf(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error("Invalid Discord timestamp.");
  return parsed;
}

function snowflakeTimestamp(value: string): number {
  discordSnowflake(value, "snowflake");
  const timestamp = Number(BigInt(value) >> 22n) + 1_420_070_400_000;
  if (!Number.isSafeInteger(timestamp)) throw new Error("Invalid Discord snowflake timestamp.");
  return timestamp;
}

function isStale(occurredAt: number, now: number, maximumAge: number): boolean {
  return !Number.isFinite(occurredAt) || !Number.isFinite(maximumAge) || maximumAge < 0 || now - occurredAt > maximumAge;
}

function isSupportedGuildType(type: number): boolean {
  return type === 0 || type === 5 || isDiscordThreadType(type);
}

function isBareCommand(source: string): boolean {
  const first = source.trim().split(/\s/u, 1)[0] ?? "";
  return /^[/!][A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(first);
}

function providerConversationId(update: DiscordGatewayUpdate): string | null {
  return update.message?.channel_id ?? update.interaction?.channel_id ?? null;
}

function providerUserId(update: DiscordGatewayUpdate): string | null {
  return update.message?.author.id ?? update.interaction?.member?.user?.id ?? update.interaction?.user?.id ?? null;
}

function ignoredEntry(
  providerRequestId: string,
  reason: MessagingIgnoredInbound["reason"],
  providerConversationIdValue: string | null,
  providerUserIdValue: string | null
): MessagingIgnoredInbound {
  return {
    providerRequestId,
    reason,
    providerConversationId: providerConversationIdValue,
    providerUserId: providerUserIdValue
  };
}

function sanitizeFileName(value: string): string {
  const cleaned = value.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/gu, "_").trim().slice(0, 160);
  return cleaned || "attachment";
}

function sanitizeLabel(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 160) || "Unsupported content";
}

function normalizeMime(value: string | null | undefined): string | null {
  const mime = value?.split(";", 1)[0]?.trim().toLowerCase();
  return mime && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(mime) ? mime : null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
