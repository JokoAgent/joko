import {
  MessagingTransportError,
  type MessagingAddress,
  type MessagingConnectionProbe,
  type MessagingDownloadedAttachment,
  type MessagingInboundAttachment,
  type MessagingSendReceipt
} from "../types.js";
import { DiscordApi, type DiscordApiOptions } from "./api.js";
import {
  actualDiscordChannelId,
  decodeDiscordAttachmentCoordinate,
  discordAddress,
  discordSnowflake
} from "./codec.js";
import {
  DiscordGatewayClient,
  type DiscordGatewayClientOptions
} from "./gateway.js";
import type {
  DiscordAttachment,
  DiscordChannel,
  DiscordGatewayUpdate,
  DiscordMessage,
  DiscordUser
} from "./model.js";
import {
  normalizeDiscordUpdates,
  type DiscordBotIdentity,
  type DiscordNormalizationOptions,
  type DiscordNormalizationResult
} from "./normalize.js";
import { DISCORD_TEXT_LIMIT } from "./text.js";

const DISCORD_MAXIMUM_OUTBOUND_FILE_BYTES = 8 * 1024 * 1024;
const DISCORD_MAXIMUM_OUTBOUND_BATCH_BYTES = 25 * 1024 * 1024;
const DISCORD_MAXIMUM_INBOUND_FILE_BYTES = 50 * 1024 * 1024;
const DISCORD_MAXIMUM_ATTACHMENT_URL_CACHE = 1_024;
const ACK_REACTION = "👀";

export interface DiscordTransportOptions extends DiscordApiOptions {
  readonly connectionId: string;
  readonly generation: number;
  readonly ownerUserId: string;
  readonly groupActivation: DiscordNormalizationOptions["groupActivation"];
  readonly initialCursor?: string | null;
  readonly now?: () => number;
  readonly maximumMessageAgeMs?: number;
  readonly gatewayRandom?: () => number;
  readonly gatewayHandshakeTimeoutMs?: number;
  readonly gatewayInvalidSessionDelayMs?: number;
  readonly createGatewaySocket?: DiscordGatewayClientOptions["createSocket"];
}

export interface DiscordConnectionProbe extends MessagingConnectionProbe {
  readonly channel: "discord";
  readonly ownerConversationId: string;
}

export interface DiscordPollResult {
  readonly updates: readonly DiscordGatewayUpdate[];
  /** Persist only after the normalized batch is durably admitted. */
  readonly nextCursor: string;
}

export interface DiscordOutboundAttachment {
  readonly kind: "image" | "file";
  readonly bytes: Uint8Array;
  readonly fileName: string;
  readonly mimeType: string;
}

export class DiscordTransport {
  readonly channel = "discord" as const;
  readonly connectionId: string;
  readonly generation: number;
  readonly #ownerUserId: string;
  readonly #token: string;
  readonly #groupActivation: DiscordNormalizationOptions["groupActivation"];
  readonly #initialCursor: string | null;
  readonly #now: () => number;
  readonly #maximumMessageAgeMs: number | undefined;
  readonly #gatewayRandom: (() => number) | undefined;
  readonly #gatewayHandshakeTimeoutMs: number | undefined;
  readonly #gatewayInvalidSessionDelayMs: number | undefined;
  readonly #createGatewaySocket: DiscordGatewayClientOptions["createSocket"] | undefined;
  readonly #api: DiscordApi;
  readonly #channels = new Map<string, DiscordChannel>();
  readonly #attachmentUrls = new Map<string, string>();
  #bot: DiscordBotIdentity | null = null;
  #ownerConversationId: string | null = null;
  #gateway: DiscordGatewayClient | null = null;
  #expectedPollCursor: string | null;

  constructor(options: DiscordTransportOptions) {
    this.connectionId = requiredIdentifier(options.connectionId, "connection");
    this.generation = requiredGeneration(options.generation);
    this.#token = requiredToken(options.token);
    this.#ownerUserId = discordSnowflake(options.ownerUserId, "owner user identifier");
    this.#groupActivation = options.groupActivation;
    this.#initialCursor = options.initialCursor ?? null;
    this.#expectedPollCursor = this.#initialCursor;
    this.#now = options.now ?? Date.now;
    this.#maximumMessageAgeMs = options.maximumMessageAgeMs;
    this.#gatewayRandom = options.gatewayRandom;
    this.#gatewayHandshakeTimeoutMs = options.gatewayHandshakeTimeoutMs;
    this.#gatewayInvalidSessionDelayMs = options.gatewayInvalidSessionDelayMs;
    this.#createGatewaySocket = options.createGatewaySocket;
    this.#api = new DiscordApi(options);
  }

  async probe(signal?: AbortSignal): Promise<DiscordConnectionProbe> {
    const user = await this.#api.currentUser(signal);
    const bot = botIdentity(user);
    const ownerDm = await this.#api.createOwnerDm(this.#ownerUserId, signal);
    const channel = validChannel(ownerDm);
    if (channel.type !== 1) throw malformed("Discord returned a non-DM owner conversation.");
    const gatewayBot = await this.#api.gatewayBot(signal);
    if (typeof gatewayBot.url !== "string") throw malformed("Discord returned an invalid Gateway endpoint.");

    const gateway = new DiscordGatewayClient({
      api: this.#api,
      gatewayUrl: gatewayBot.url,
      token: this.#token,
      botUserId: bot.id,
      initialCursor: this.#initialCursor,
      allowLoopback: this.#api.allowsLoopbackProvider,
      ...(this.#gatewayRandom === undefined ? {} : { random: this.#gatewayRandom }),
      ...(this.#gatewayHandshakeTimeoutMs === undefined ? {} : { handshakeTimeoutMs: this.#gatewayHandshakeTimeoutMs }),
      ...(this.#gatewayInvalidSessionDelayMs === undefined ? {} : { invalidSessionDelayMs: this.#gatewayInvalidSessionDelayMs }),
      ...(this.#createGatewaySocket === undefined ? {} : { createSocket: this.#createGatewaySocket })
    });
    try {
      await gateway.connect(signal);
    } catch (error) {
      await gateway.close().catch(() => undefined);
      throw error;
    }
    await this.#gateway?.close().catch(() => undefined);
    this.#gateway = gateway;
    this.#bot = bot;
    this.#ownerConversationId = channel.id;
    this.#channels.set(channel.id, channel);
    return {
      channel: "discord",
      connectionId: this.connectionId,
      generation: this.generation,
      providerAccountId: bot.id,
      displayName: bot.displayName,
      username: bot.username,
      ownerConversationId: channel.id
    };
  }

  async poll(input: {
    readonly cursor: string | null;
    readonly timeoutSeconds?: number;
    readonly signal?: AbortSignal;
  }): Promise<DiscordPollResult> {
    const gateway = this.#requireGateway();
    if ((input.cursor ?? null) !== this.#expectedPollCursor) {
      throw invalidInput("Discord poll cursor does not match the active Gateway session.");
    }
    const result = await gateway.poll({
      ...(input.timeoutSeconds === undefined ? {} : { timeoutSeconds: input.timeoutSeconds }),
      ...(input.signal === undefined ? {} : { signal: input.signal })
    });
    const updates: DiscordGatewayUpdate[] = [];
    for (const dispatch of result.dispatches) {
      input.signal?.throwIfAborted();
      if (dispatch.eventType === "MESSAGE_CREATE" && dispatch.message !== undefined) {
        const channel = await this.#channel(dispatch.message.channel_id, dispatch.message.guild_id, input.signal);
        this.#rememberAttachmentUrls(dispatch.message);
        updates.push({ ...dispatch, channel });
      } else if (dispatch.eventType === "INTERACTION_CREATE" && dispatch.interaction !== undefined) {
        const channelId = dispatch.interaction.channel_id ?? dispatch.interaction.message?.channel_id;
        if (channelId === undefined) throw malformed("Discord interaction omitted its channel.");
        const channel = await this.#channel(channelId, dispatch.interaction.guild_id, input.signal);
        if (dispatch.interaction.message !== undefined) this.#rememberAttachmentUrls(dispatch.interaction.message);
        updates.push({ ...dispatch, channel });
      }
    }
    this.#expectedPollCursor = result.nextCursor;
    return { updates, nextCursor: result.nextCursor };
  }

  normalize(updates: readonly DiscordGatewayUpdate[]): DiscordNormalizationResult {
    if (this.#bot === null || this.#ownerConversationId === null) {
      throw invalidInput("Probe the Discord connection before normalizing events.");
    }
    const result = normalizeDiscordUpdates(updates, {
      connectionId: this.connectionId,
      ownerUserId: this.#ownerUserId,
      ownerConversationId: this.#ownerConversationId,
      bot: this.#bot,
      groupActivation: this.#groupActivation,
      now: this.#now,
      ...(this.#maximumMessageAgeMs === undefined ? {} : { maximumMessageAgeMs: this.#maximumMessageAgeMs })
    });
    const admittedInteractions = new Set(result.events.flatMap((event) =>
      event.kind === "interaction" ? [event.interactionId] : []));
    const gateway = this.#requireGateway();
    for (const update of updates) {
      const interactionId = update.interaction?.id;
      if (interactionId !== undefined && !admittedInteractions.has(interactionId)) {
        gateway.consumeInteractionAck(interactionId);
      }
    }
    return result;
  }

  async downloadAttachment(
    attachment: MessagingInboundAttachment,
    signal?: AbortSignal
  ): Promise<MessagingDownloadedAttachment> {
    const coordinate = decodeDiscordAttachmentCoordinate(attachment.providerFileId);
    let url = this.#attachmentUrls.get(attachment.providerFileId);
    if (url === undefined) {
      const message = await this.#api.message(coordinate.channelId, coordinate.messageId, signal);
      const providerAttachment = message.attachments?.find((candidate) => candidate.id === coordinate.attachmentId);
      if (providerAttachment === undefined) throw providerRejected("Discord attachment is no longer available.");
      this.#rememberAttachmentUrl(message, providerAttachment);
      url = this.#attachmentUrls.get(attachment.providerFileId);
    }
    if (url === undefined) throw malformed("Discord attachment URL was unavailable.");
    const maximum = attachment.byteLength === null
      ? DISCORD_MAXIMUM_INBOUND_FILE_BYTES
      : Math.min(attachment.byteLength, DISCORD_MAXIMUM_INBOUND_FILE_BYTES);
    const downloaded = await this.#api.download(url, Math.max(1, maximum), signal);
    return {
      bytes: downloaded.bytes,
      fileName: attachment.fileName,
      mimeType: attachment.mimeType ?? downloaded.mimeType
    };
  }

  async sendTextPart(input: {
    readonly address: MessagingAddress;
    readonly text: string;
    readonly replyToMessageId?: string;
    readonly signal?: AbortSignal;
  }): Promise<MessagingSendReceipt> {
    const channelId = this.#assertAddress(input.address);
    if (input.text.length < 1 || input.text.length > DISCORD_TEXT_LIMIT) {
      throw invalidInput(`Discord text must contain 1-${DISCORD_TEXT_LIMIT} UTF-16 code units.`);
    }
    const sent = await this.#api.sendMessage(channelId, {
      content: input.text,
      allowed_mentions: { parse: [] },
      ...(input.replyToMessageId === undefined ? {} : {
        message_reference: {
          message_id: discordSnowflake(input.replyToMessageId, "reply message identifier"),
          fail_if_not_exists: false
        }
      })
    }, input.signal);
    return receiptOf(sent, input.address);
  }

  async sendAttachments(input: {
    readonly address: MessagingAddress;
    readonly attachments: readonly DiscordOutboundAttachment[];
    readonly replyToMessageId?: string;
    readonly signal?: AbortSignal;
  }): Promise<MessagingSendReceipt> {
    const channelId = this.#assertAddress(input.address);
    if (input.attachments.length < 1 || input.attachments.length > 10) {
      throw invalidInput("Discord attachment delivery must contain 1-10 files.");
    }
    const attachments = input.attachments.map(validateOutboundAttachment);
    const total = attachments.reduce((size, attachment) => size + attachment.bytes.byteLength, 0);
    if (total > DISCORD_MAXIMUM_OUTBOUND_BATCH_BYTES) throw payloadTooLarge();
    const payload = {
      attachments: attachments.map((attachment, index) => ({ id: index, filename: attachment.fileName })),
      allowed_mentions: { parse: [] },
      ...(input.replyToMessageId === undefined ? {} : {
        message_reference: {
          message_id: discordSnowflake(input.replyToMessageId, "reply message identifier"),
          fail_if_not_exists: false
        }
      })
    };
    const form = new FormData();
    form.set("payload_json", JSON.stringify(payload));
    attachments.forEach((attachment, index) => {
      form.set(`files[${index}]`, attachmentBlob(attachment), attachment.fileName);
    });
    const sent = await this.#api.sendMessageForm(channelId, form, input.signal);
    return receiptOf(sent, input.address);
  }

  async sendInteractionCard(input: {
    readonly address: MessagingAddress;
    readonly text: string;
    readonly buttons: readonly { readonly label: string; readonly actionValue: string }[];
    readonly signal?: AbortSignal;
  }): Promise<MessagingSendReceipt> {
    const channelId = this.#assertAddress(input.address);
    const text = input.text.trim();
    if (text.length < 1 || text.length > 4_096) {
      throw invalidInput("Discord interaction text must contain 1-4096 UTF-16 code units.");
    }
    if (input.buttons.length > 25) throw invalidInput("Discord interaction must contain at most 25 buttons.");
    const buttons = input.buttons.map((button) => {
      const label = button.label.trim();
      const actionBytes = new TextEncoder().encode(button.actionValue).byteLength;
      if (label.length < 1 || label.length > 80 || /[\u0000-\u001f\u007f]/u.test(label)) {
        throw invalidInput("Invalid Discord interaction button label.");
      }
      if (actionBytes < 1 || actionBytes > 100 || /[\u0000-\u001f\u007f]/u.test(button.actionValue)) {
        throw invalidInput("Invalid Discord interaction button value.");
      }
      return { type: 2, style: 2, label, custom_id: button.actionValue };
    });
    const components: Array<{ readonly type: 1; readonly components: typeof buttons }> = [];
    for (let index = 0; index < buttons.length; index += 5) {
      components.push({ type: 1, components: buttons.slice(index, index + 5) });
    }
    const sent = await this.#api.sendMessage(channelId, {
      embeds: [{ description: text }],
      components,
      allowed_mentions: { parse: [] }
    }, input.signal);
    return receiptOf(sent, input.address);
  }

  async clearInteractionCard(input: {
    readonly address: MessagingAddress;
    readonly messageId: string;
    readonly signal?: AbortSignal;
  }): Promise<MessagingSendReceipt> {
    const channelId = this.#assertAddress(input.address);
    const messageId = discordSnowflake(input.messageId, "message identifier");
    const edited = await this.#api.editMessage(channelId, messageId, { components: [] }, input.signal);
    const receipt = receiptOf(edited, input.address);
    if (receipt.providerMessageId !== messageId) throw malformed("Discord edited a different interaction message.");
    return receipt;
  }

  async sendTyping(address: MessagingAddress, signal?: AbortSignal): Promise<void> {
    await this.#api.typing(this.#assertAddress(address), signal);
  }

  async setReaction(input: {
    readonly address: MessagingAddress;
    readonly messageId: string;
    readonly emoji: string | null;
    readonly signal?: AbortSignal;
  }): Promise<void> {
    const channelId = this.#assertAddress(input.address);
    const messageId = discordSnowflake(input.messageId, "message identifier");
    if (input.emoji === null) {
      await this.#api.removeReaction(channelId, messageId, ACK_REACTION, input.signal);
      return;
    }
    if (input.emoji.length < 1 || input.emoji.length > 32 || /[\u0000-\u001f\u007f]/u.test(input.emoji)) {
      throw invalidInput("Invalid Discord reaction.");
    }
    await this.#api.addReaction(channelId, messageId, input.emoji, input.signal);
  }

  async answerInteraction(input: {
    readonly interactionId: string;
    readonly text?: string;
    readonly showAlert?: boolean;
    readonly signal?: AbortSignal;
  }): Promise<void> {
    input.signal?.throwIfAborted();
    const interactionId = discordSnowflake(input.interactionId, "interaction identifier");
    const gateway = this.#requireGateway();
    const failure = gateway.interactionAckFailure(interactionId);
    if (failure !== undefined) throw failure;
    gateway.consumeInteractionAck(interactionId);
  }

  ownerAddress(): MessagingAddress {
    if (this.#ownerConversationId === null) throw invalidInput("Probe the Discord connection before requesting its owner address.");
    return discordAddress({
      connectionId: this.connectionId,
      channel: { id: this.#ownerConversationId, type: 1 }
    });
  }

  async close(): Promise<void> {
    const gateway = this.#gateway;
    this.#gateway = null;
    await gateway?.close();
  }

  async #channel(channelIdValue: string, fallbackGuildId: string | undefined, signal?: AbortSignal): Promise<DiscordChannel> {
    const channelId = discordSnowflake(channelIdValue, "channel identifier");
    const cached = this.#channels.get(channelId);
    if (cached !== undefined) return cached;
    const fetched = validChannel(await this.#api.channel(channelId, signal));
    const channel = fetched.guild_id === undefined && fallbackGuildId !== undefined
      ? { ...fetched, guild_id: discordSnowflake(fallbackGuildId, "guild identifier") }
      : fetched;
    this.#channels.set(channelId, channel);
    return channel;
  }

  #rememberAttachmentUrls(message: DiscordMessage): void {
    for (const attachment of message.attachments ?? []) this.#rememberAttachmentUrl(message, attachment);
  }

  #rememberAttachmentUrl(message: DiscordMessage, attachment: DiscordAttachment): void {
    const coordinate = `${discordSnowflake(message.channel_id)}/${discordSnowflake(message.id)}/${discordSnowflake(attachment.id)}`;
    this.#attachmentUrls.delete(coordinate);
    this.#attachmentUrls.set(coordinate, attachment.url);
    while (this.#attachmentUrls.size > DISCORD_MAXIMUM_ATTACHMENT_URL_CACHE) {
      const oldest = this.#attachmentUrls.keys().next().value;
      if (oldest === undefined) break;
      this.#attachmentUrls.delete(oldest);
    }
  }

  #assertAddress(address: MessagingAddress): string {
    if (address.channel !== "discord" || address.connectionId !== this.connectionId) {
      throw invalidInput("Discord address does not belong to this connection.");
    }
    if (address.conversationKind === "direct" && address.providerThreadId !== null) {
      throw invalidInput("Discord direct-message address cannot contain a thread.");
    }
    return actualDiscordChannelId(address);
  }

  #requireGateway(): DiscordGatewayClient {
    if (this.#gateway === null) throw invalidInput("Probe the Discord connection before using its Gateway.");
    return this.#gateway;
  }

}

function botIdentity(user: DiscordUser): DiscordBotIdentity {
  const id = discordSnowflake(user.id, "bot user identifier");
  const username = user.username?.trim();
  if (user.bot !== true || username === undefined || username.length === 0 || username.length > 80) {
    throw malformed("Discord returned an invalid bot identity.");
  }
  return {
    id,
    username,
    displayName: user.global_name?.trim() || username
  };
}

function validChannel(value: DiscordChannel): DiscordChannel {
  const id = discordSnowflake(value.id, "channel identifier");
  if (!Number.isSafeInteger(value.type) || value.type < 0 || value.type > 32) {
    throw malformed("Discord returned an invalid channel.");
  }
  return {
    id,
    type: value.type,
    ...(value.guild_id === undefined ? {} : { guild_id: discordSnowflake(value.guild_id, "guild identifier") }),
    ...(value.parent_id === undefined ? {} : {
      parent_id: value.parent_id === null ? null : discordSnowflake(value.parent_id, "parent channel identifier")
    }),
    ...(value.name === undefined ? {} : { name: value.name })
  };
}

function receiptOf(message: DiscordMessage, address: MessagingAddress): MessagingSendReceipt {
  return { providerMessageId: discordSnowflake(message.id, "message identifier"), address };
}

function validateOutboundAttachment(attachment: DiscordOutboundAttachment): DiscordOutboundAttachment {
  const fileName = attachment.fileName.trim();
  if (fileName.length < 1 || fileName.length > 256 || /[\u0000-\u001f\u007f]/u.test(fileName)) {
    throw invalidInput("Invalid Discord attachment file name.");
  }
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(attachment.mimeType)) {
    throw invalidInput("Invalid Discord attachment media type.");
  }
  if (attachment.bytes.byteLength < 1 || attachment.bytes.byteLength > DISCORD_MAXIMUM_OUTBOUND_FILE_BYTES) {
    throw payloadTooLarge();
  }
  return { ...attachment, fileName };
}

function attachmentBlob(attachment: DiscordOutboundAttachment): Blob {
  const copy = new Uint8Array(attachment.bytes.byteLength);
  copy.set(attachment.bytes);
  return new Blob([copy.buffer], { type: attachment.mimeType });
}

function requiredIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 256 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw invalidInput(`Invalid Discord ${label} identifier.`);
  }
  return normalized;
}

function requiredGeneration(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw invalidInput("Invalid Discord connection generation.");
  return value;
}

function requiredToken(value: string): string {
  const token = value.trim();
  if (!/^[A-Za-z0-9._-]{24,256}$/u.test(token)) throw invalidInput("Invalid Discord bot token shape.");
  return token;
}

function malformed(message: string): MessagingTransportError {
  return new MessagingTransportError("malformed_response", message, { retryable: false, effect: "none" });
}

function providerRejected(message: string): MessagingTransportError {
  return new MessagingTransportError("provider_rejected", message, { retryable: false, effect: "none" });
}

function payloadTooLarge(): MessagingTransportError {
  return new MessagingTransportError("payload_too_large", "Discord attachment exceeds the upload limit.", {
    retryable: false,
    effect: "none"
  });
}

function invalidInput(message: string): MessagingTransportError {
  return new MessagingTransportError("invalid_input", message, { retryable: false, effect: "none" });
}
