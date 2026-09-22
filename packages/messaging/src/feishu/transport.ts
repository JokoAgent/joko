import {
  MessagingTransportError,
  type MessagingAddress,
  type MessagingConnectionProbe,
  type MessagingDownloadedAttachment,
  type MessagingGroupObservation,
  type MessagingInboundAttachment,
  type MessagingSendReceipt
} from "../types.js";
import {
  FEISHU_MAXIMUM_FILE_BYTES,
  FEISHU_MAXIMUM_IMAGE_BYTES,
  FeishuApi,
  type FeishuApiOptions,
  type FeishuApiPort,
  type FeishuOutboundAttachment
} from "./api.js";
import { buildFeishuClosedCard, buildFeishuInteractionCard } from "./cards.js";
import { feishuAddress, requiredFeishuIdentifier } from "./codec.js";
import { parseFeishuContent } from "./content.js";
import type { FeishuCallbackUpdate, FeishuService } from "./model.js";
import {
  feishuHistoryObservation,
  normalizeFeishuUpdates,
  type FeishuNormalizationOptions,
  type FeishuNormalizationResult
} from "./normalize.js";
import {
  FeishuStreamClient,
  type FeishuPollResult,
  type FeishuStreamClientOptions
} from "./stream.js";
import { FEISHU_TEXT_LIMIT } from "./text.js";

const MAXIMUM_TRANSIENT_COORDINATES = 2_048;
const MAXIMUM_INTERACTION_BUTTONS = 100;

export interface FeishuTransportOptions {
  readonly appId: string;
  readonly appSecret: string;
  readonly service: FeishuService;
  readonly connectionId: string;
  readonly generation: number;
  readonly ownerUserId: string | null;
  readonly groupActivation: FeishuNormalizationOptions["groupActivation"];
  readonly initialCursor?: string | null;
  readonly maximumMessageAgeMs?: number;
  readonly handshakeTimeoutMs?: number;
  readonly pingTimeoutSeconds?: number;
  readonly now?: () => number;
  readonly api?: FeishuApiPort;
  readonly stream?: FeishuStreamClient;
  readonly client?: FeishuApiOptions["client"];
  readonly createStreamClient?: FeishuStreamClientOptions["createClient"];
  readonly createDispatcher?: FeishuStreamClientOptions["createDispatcher"];
}

export interface FeishuConnectionProbe extends MessagingConnectionProbe {
  readonly channel: FeishuService;
}

interface AttachmentCoordinate {
  readonly messageId: string;
  readonly providerKey: string;
  readonly kind: "image" | "file";
  readonly fileName: string;
  readonly mimeType: string | null;
}

export class FeishuTransport {
  readonly channel: FeishuService;
  readonly connectionId: string;
  readonly generation: number;
  readonly #appId: string;
  readonly #groupActivation: FeishuNormalizationOptions["groupActivation"];
  readonly #now: () => number;
  readonly #maximumMessageAgeMs: number | undefined;
  readonly #api: FeishuApiPort;
  readonly #stream: FeishuStreamClient;
  readonly #attachments = new Map<string, AttachmentCoordinate>();
  #ownerUserId: string | null;
  #botOpenId: string | null = null;
  #probed = false;

  constructor(options: FeishuTransportOptions) {
    this.channel = options.service;
    this.connectionId = requiredFeishuIdentifier(options.connectionId, "connection", 256);
    this.generation = requiredGeneration(options.generation);
    this.#appId = requiredFeishuIdentifier(options.appId, "app", 256);
    this.#ownerUserId = options.ownerUserId === null
      ? null
      : requiredFeishuIdentifier(options.ownerUserId, "owner user");
    this.#groupActivation = options.groupActivation;
    this.#now = options.now ?? Date.now;
    this.#maximumMessageAgeMs = options.maximumMessageAgeMs;
    this.#api = options.api ?? new FeishuApi({
      appId: this.#appId,
      appSecret: options.appSecret,
      service: options.service,
      ...(options.client === undefined ? {} : { client: options.client })
    });
    this.#stream = options.stream ?? new FeishuStreamClient({
      appId: this.#appId,
      appSecret: options.appSecret,
      service: options.service,
      connectionId: this.connectionId,
      initialCursor: options.initialCursor ?? null,
      now: this.#now,
      ...(options.handshakeTimeoutMs === undefined ? {} : { handshakeTimeoutMs: options.handshakeTimeoutMs }),
      ...(options.pingTimeoutSeconds === undefined ? {} : { pingTimeoutSeconds: options.pingTimeoutSeconds }),
      ...(options.createStreamClient === undefined ? {} : { createClient: options.createStreamClient }),
      ...(options.createDispatcher === undefined ? {} : { createDispatcher: options.createDispatcher })
    });
  }

  async probe(signal?: AbortSignal): Promise<FeishuConnectionProbe> {
    const identity = await this.#api.probe(signal);
    if (identity.appId !== this.#appId) throw invalidInput("Feishu bot identity does not match the configured application.");
    await this.#stream.connect(signal);
    this.#botOpenId = identity.botOpenId;
    this.#probed = true;
    return {
      channel: this.channel,
      connectionId: this.connectionId,
      generation: this.generation,
      providerAccountId: this.#appId,
      displayName: identity.displayName,
      username: null
    };
  }

  async poll(input: {
    readonly cursor: string | null;
    readonly timeoutSeconds?: number;
    readonly signal?: AbortSignal;
  }): Promise<FeishuPollResult> {
    this.#requireProbe();
    const result = await this.#stream.poll(input);
    const updates: FeishuCallbackUpdate[] = [];
    for (const update of result.updates) {
      if (update.kind !== "message" || update.message.parentId === null) {
        updates.push(update);
        continue;
      }
      const replyContext = await this.#api.resolveReplyContext(
        update.message.parentId,
        update.message.chatId,
        input.signal
      ).catch(() => null);
      updates.push({
        ...update,
        message: { ...update.message, replyContext }
      });
    }
    return { updates, nextCursor: result.nextCursor };
  }

  normalize(updates: readonly FeishuCallbackUpdate[]): FeishuNormalizationResult {
    this.#requireProbe();
    const result = normalizeFeishuUpdates(updates, {
      service: this.channel,
      connectionId: this.connectionId,
      appId: this.#appId,
      botOpenId: this.#botOpenId!,
      ownerUserId: this.#ownerUserId,
      groupActivation: this.#groupActivation,
      now: this.#now,
      ...(this.#maximumMessageAgeMs === undefined ? {} : { maximumMessageAgeMs: this.#maximumMessageAgeMs })
    });
    if (result.ownerClaimProviderUserId !== null) this.#ownerUserId = result.ownerClaimProviderUserId;
    for (const event of result.events) {
      if (event.kind !== "message") continue;
      for (const attachment of event.attachments) {
        if (attachment.providerUniqueFileId === null) continue;
        this.#remember(attachment.providerFileId, {
          messageId: event.messageId,
          providerKey: attachment.providerUniqueFileId,
          kind: attachment.kind,
          fileName: attachment.fileName,
          mimeType: attachment.mimeType
        });
      }
    }
    return result;
  }

  async loadGroupHistory(address: MessagingAddress, signal?: AbortSignal): Promise<readonly MessagingGroupObservation[]> {
    this.#assertAddress(address);
    if (address.conversationKind === "direct") return [];
    const messages = await this.#api.listHistory(address, 250, signal);
    return messages.flatMap((message) => {
      const observation = feishuHistoryObservation({
        service: this.channel,
        connectionId: this.connectionId,
        ownerUserId: this.#ownerUserId,
        message
      });
      return observation === null ? [] : [observation];
    });
  }

  async downloadAttachment(
    attachment: MessagingInboundAttachment,
    signal?: AbortSignal
  ): Promise<MessagingDownloadedAttachment> {
    const coordinate = this.#attachments.get(attachment.providerFileId);
    if (coordinate === undefined || coordinate.kind !== attachment.kind) {
      throw new MessagingTransportError(
        "provider_rejected",
        "Feishu attachment download information is no longer available.",
        { retryable: false, effect: "none" }
      );
    }
    const downloaded = await this.#api.downloadAttachment({
      messageId: coordinate.messageId,
      providerKey: coordinate.providerKey,
      kind: coordinate.kind,
      maximumBytes: Math.min(
        attachment.byteLength ?? (coordinate.kind === "image" ? FEISHU_MAXIMUM_IMAGE_BYTES : FEISHU_MAXIMUM_FILE_BYTES),
        coordinate.kind === "image" ? FEISHU_MAXIMUM_IMAGE_BYTES : FEISHU_MAXIMUM_FILE_BYTES
      ),
      ...(signal === undefined ? {} : { signal })
    });
    return {
      bytes: downloaded.bytes,
      fileName: coordinate.fileName,
      mimeType: coordinate.mimeType ?? downloaded.mimeType
    };
  }

  async sendTextPart(input: {
    readonly address: MessagingAddress;
    readonly text: string;
    readonly replyToMessageId?: string;
    readonly signal?: AbortSignal;
  }): Promise<MessagingSendReceipt> {
    this.#assertAddress(input.address);
    if (input.text.length < 1 || input.text.length > FEISHU_TEXT_LIMIT) {
      throw invalidInput(`Feishu text must contain 1-${FEISHU_TEXT_LIMIT} UTF-16 code units.`);
    }
    const providerMessageId = await this.#api.sendText(
      input.address,
      input.text,
      input.replyToMessageId,
      input.signal
    );
    return { providerMessageId, address: input.address };
  }

  async sendAttachments(input: {
    readonly address: MessagingAddress;
    readonly attachments: readonly FeishuOutboundAttachment[];
    readonly replyToMessageId?: string;
    readonly signal?: AbortSignal;
  }): Promise<MessagingSendReceipt> {
    this.#assertAddress(input.address);
    if (input.attachments.length !== 1) throw invalidInput("Feishu attachment delivery must contain exactly one file.");
    const providerMessageId = await this.#api.sendAttachment(
      input.address,
      input.attachments[0]!,
      input.replyToMessageId,
      input.signal
    );
    return { providerMessageId, address: input.address };
  }

  async sendInteractionCard(input: {
    readonly address: MessagingAddress;
    readonly text: string;
    readonly buttons: readonly { readonly label: string; readonly actionValue: string }[];
    readonly signal?: AbortSignal;
  }): Promise<MessagingSendReceipt> {
    this.#assertAddress(input.address);
    if (input.buttons.length > MAXIMUM_INTERACTION_BUTTONS) {
      throw invalidInput(`Feishu interaction must contain at most ${MAXIMUM_INTERACTION_BUTTONS} choices.`);
    }
    const card = buildFeishuInteractionCard(input);
    const providerMessageId = await this.#api.sendCard(input.address, card, input.signal);
    return { providerMessageId, address: input.address };
  }

  async clearInteractionCard(input: {
    readonly address: MessagingAddress;
    readonly messageId: string;
    readonly signal?: AbortSignal;
  }): Promise<MessagingSendReceipt> {
    this.#assertAddress(input.address);
    await this.#api.patchCard(input.messageId, buildFeishuClosedCard(), input.signal);
    return { providerMessageId: requiredFeishuIdentifier(input.messageId, "message"), address: input.address };
  }

  async sendTyping(address: MessagingAddress, signal?: AbortSignal): Promise<void> {
    this.#assertAddress(address);
    signal?.throwIfAborted();
  }

  async setReaction(input: {
    readonly address: MessagingAddress;
    readonly messageId: string;
    readonly emoji: string | null;
    readonly signal?: AbortSignal;
  }): Promise<void> {
    this.#assertAddress(input.address);
    if (input.emoji === null) return;
    const emojiType = input.emoji === "👀" ? "EYES"
      : input.emoji === "✅" ? "DONE"
        : input.emoji === "❌" ? "CROSSMARK" : "SMILE";
    await this.#api.addReaction(input.messageId, emojiType, input.signal);
  }

  async answerInteraction(input: {
    readonly interactionId: string;
    readonly text?: string;
    readonly showAlert?: boolean;
    readonly signal?: AbortSignal;
  }): Promise<void> {
    requiredFeishuIdentifier(input.interactionId, "interaction");
    input.signal?.throwIfAborted();
  }

  ownerAddress(): MessagingAddress {
    if (this.#ownerUserId === null) throw invalidInput("The Feishu/Lark owner has not claimed this connection yet.");
    return feishuAddress({
      service: this.channel,
      connectionId: this.connectionId,
      providerConversationId: this.#ownerUserId,
      group: false
    });
  }

  async close(): Promise<void> {
    await this.#stream.close();
    this.#attachments.clear();
  }

  #assertAddress(address: MessagingAddress): void {
    if (address.channel !== this.channel || address.connectionId !== this.connectionId) {
      throw invalidInput("Feishu address does not belong to this connection.");
    }
    if (address.conversationKind === "channel") throw invalidInput("Feishu address has an unsupported conversation shape.");
    if (address.conversationKind === "direct" && address.providerThreadId !== null) {
      throw invalidInput("Feishu direct messages cannot carry a topic identity.");
    }
    requiredFeishuIdentifier(address.providerConversationId, "conversation");
    if (address.providerThreadId !== null) requiredFeishuIdentifier(address.providerThreadId, "thread");
  }

  #remember(key: string, value: AttachmentCoordinate): void {
    this.#attachments.delete(key);
    this.#attachments.set(key, value);
    while (this.#attachments.size > MAXIMUM_TRANSIENT_COORDINATES) {
      const oldest = this.#attachments.keys().next().value;
      if (oldest === undefined) break;
      this.#attachments.delete(oldest);
    }
  }

  #requireProbe(): void {
    if (!this.#probed || this.#botOpenId === null) throw invalidInput("Probe the Feishu connection before using its WebSocket.");
  }
}

function requiredGeneration(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw invalidInput("Feishu connection generation is invalid.");
  return value;
}

function invalidInput(message: string): MessagingTransportError {
  return new MessagingTransportError("invalid_input", message, { retryable: false, effect: "none" });
}
