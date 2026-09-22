import {
  MessagingTransportError,
  type MessagingAddress,
  type MessagingConnectionProbe,
  type MessagingDownloadedAttachment,
  type MessagingInboundAttachment,
  type MessagingSendReceipt
} from "../types.js";
import {
  DINGTALK_MAXIMUM_ATTACHMENT_BYTES,
  DingTalkApi,
  type DingTalkApiOptions,
  type DingTalkOutboundAttachment,
  type DingTalkOutboundTarget
} from "./api.js";
import { dingTalkAddress, dingTalkAttachmentCoordinate, requiredDingTalkProviderId } from "./codec.js";
import type { DingTalkCallbackUpdate } from "./model.js";
import {
  normalizeDingTalkUpdates,
  parseDingTalkContent,
  parseDingTalkEnvelope,
  type DingTalkNormalizationOptions,
  type DingTalkNormalizationResult
} from "./normalize.js";
import {
  DingTalkStreamClient,
  type DingTalkStreamClientOptions
} from "./stream.js";
import { DINGTALK_TEXT_LIMIT } from "./text.js";

const MAXIMUM_TRANSIENT_COORDINATES = 2_048;
const MAXIMUM_INTERACTION_BUTTONS = 25;

export interface DingTalkTransportOptions extends DingTalkApiOptions {
  readonly connectionId: string;
  readonly generation: number;
  readonly ownerUserId: string | null;
  readonly groupActivation: DingTalkNormalizationOptions["groupActivation"];
  readonly initialCursor?: string | null;
  readonly maximumMessageAgeMs?: number;
  readonly streamHandshakeTimeoutMs?: number;
  readonly streamHeartbeatIntervalMs?: number;
  readonly createStreamSocket?: DingTalkStreamClientOptions["createSocket"];
}

export interface DingTalkPollResult {
  readonly updates: readonly DingTalkCallbackUpdate[];
  /** Persist only after the normalized batch is durably admitted. */
  readonly nextCursor: string;
}

export interface DingTalkConnectionProbe extends MessagingConnectionProbe {
  readonly channel: "dingtalk";
}

export class DingTalkTransport {
  readonly channel = "dingtalk" as const;
  readonly connectionId: string;
  readonly generation: number;
  readonly #appKey: string;
  readonly #groupActivation: DingTalkNormalizationOptions["groupActivation"];
  readonly #now: () => number;
  readonly #maximumMessageAgeMs: number | undefined;
  readonly #api: DingTalkApi;
  readonly #stream: DingTalkStreamClient;
  readonly #targets = new Map<string, DingTalkOutboundTarget>();
  readonly #downloadCodes = new Map<string, string>();
  #ownerUserId: string | null;
  #expectedPollCursor: string | null;
  #probed = false;

  constructor(options: DingTalkTransportOptions) {
    this.connectionId = requiredIdentifier(options.connectionId, "connection");
    this.generation = requiredGeneration(options.generation);
    this.#appKey = requiredDingTalkProviderId(options.appKey, "app key");
    this.#ownerUserId = options.ownerUserId === null
      ? null
      : requiredDingTalkProviderId(options.ownerUserId, "owner user");
    this.#groupActivation = options.groupActivation;
    this.#now = options.now ?? Date.now;
    this.#maximumMessageAgeMs = options.maximumMessageAgeMs;
    this.#expectedPollCursor = options.initialCursor ?? null;
    this.#api = new DingTalkApi(options);
    this.#stream = new DingTalkStreamClient({
      api: this.#api,
      initialCursor: options.initialCursor ?? null,
      ...(options.streamHandshakeTimeoutMs === undefined
        ? {}
        : { handshakeTimeoutMs: options.streamHandshakeTimeoutMs }),
      ...(options.streamHeartbeatIntervalMs === undefined
        ? {}
        : { heartbeatIntervalMs: options.streamHeartbeatIntervalMs }),
      ...(options.createStreamSocket === undefined ? {} : { createSocket: options.createStreamSocket })
    });
  }

  async probe(signal?: AbortSignal): Promise<DingTalkConnectionProbe> {
    await this.#api.validateCredentials(signal);
    await this.#stream.connect(signal);
    this.#probed = true;
    return {
      channel: "dingtalk",
      connectionId: this.connectionId,
      generation: this.generation,
      providerAccountId: this.#appKey,
      displayName: "DingTalk bot",
      username: null
    };
  }

  async poll(input: {
    readonly cursor: string | null;
    readonly timeoutSeconds?: number;
    readonly signal?: AbortSignal;
  }): Promise<DingTalkPollResult> {
    this.#requireProbe();
    if ((input.cursor ?? null) !== this.#expectedPollCursor) {
      throw invalidInput("DingTalk poll cursor does not match the active Stream session.");
    }
    const result = await this.#stream.poll({
      ...(input.timeoutSeconds === undefined ? {} : { timeoutSeconds: input.timeoutSeconds }),
      ...(input.signal === undefined ? {} : { signal: input.signal })
    });
    this.#expectedPollCursor = result.nextCursor;
    return result;
  }

  normalize(updates: readonly DingTalkCallbackUpdate[]): DingTalkNormalizationResult {
    this.#requireProbe();
    const result = normalizeDingTalkUpdates(updates, {
      connectionId: this.connectionId,
      appKey: this.#appKey,
      ownerUserId: this.#ownerUserId,
      groupActivation: this.#groupActivation,
      now: this.#now,
      ...(this.#maximumMessageAgeMs === undefined ? {} : { maximumMessageAgeMs: this.#maximumMessageAgeMs })
    });
    if (result.ownerClaimProviderUserId !== null) {
      this.#ownerUserId = result.ownerClaimProviderUserId;
    }
    this.#rememberTransientCoordinates(updates, result);
    return result;
  }

  async downloadAttachment(
    attachment: MessagingInboundAttachment,
    signal?: AbortSignal
  ): Promise<MessagingDownloadedAttachment> {
    const downloadCode = this.#downloadCodes.get(attachment.providerFileId);
    if (downloadCode === undefined) {
      throw new MessagingTransportError(
        "provider_rejected",
        "DingTalk attachment download information is no longer available.",
        { retryable: false, effect: "none" }
      );
    }
    const maximumBytes = attachment.byteLength === null
      ? DINGTALK_MAXIMUM_ATTACHMENT_BYTES
      : Math.min(attachment.byteLength, DINGTALK_MAXIMUM_ATTACHMENT_BYTES);
    const downloaded = await this.#api.downloadAttachment(downloadCode, Math.max(1, maximumBytes), signal);
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
    const target = this.#target(input.address);
    if (input.text.length < 1 || input.text.length > DINGTALK_TEXT_LIMIT) {
      throw invalidInput(`DingTalk text must contain 1-${DINGTALK_TEXT_LIMIT} UTF-16 code units.`);
    }
    const providerMessageId = await this.#api.sendText(target, input.text, input.signal);
    return { providerMessageId, address: input.address };
  }

  async sendAttachments(input: {
    readonly address: MessagingAddress;
    readonly attachments: readonly DingTalkOutboundAttachment[];
    readonly replyToMessageId?: string;
    readonly signal?: AbortSignal;
  }): Promise<MessagingSendReceipt> {
    const target = this.#target(input.address);
    if (input.attachments.length !== 1) {
      throw invalidInput("DingTalk attachment delivery must contain exactly one file.");
    }
    const providerMessageId = await this.#api.sendAttachment(target, input.attachments[0]!, input.signal);
    return { providerMessageId, address: input.address };
  }

  async sendInteractionCard(input: {
    readonly address: MessagingAddress;
    readonly text: string;
    readonly buttons: readonly { readonly label: string; readonly actionValue: string }[];
    readonly signal?: AbortSignal;
  }): Promise<MessagingSendReceipt> {
    if (input.buttons.length > MAXIMUM_INTERACTION_BUTTONS) {
      throw invalidInput(`DingTalk interaction must contain at most ${MAXIMUM_INTERACTION_BUTTONS} choices.`);
    }
    const prompt = formatInteractionPrompt(input.text, input.buttons);
    return this.sendTextPart({ address: input.address, text: prompt, signal: input.signal });
  }

  async clearInteractionCard(input: {
    readonly address: MessagingAddress;
    readonly messageId: string;
    readonly signal?: AbortSignal;
  }): Promise<MessagingSendReceipt> {
    this.#assertAddress(input.address);
    input.signal?.throwIfAborted();
    return {
      providerMessageId: requiredDingTalkProviderId(input.messageId, "message"),
      address: input.address
    };
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
    requiredDingTalkProviderId(input.messageId, "message");
    input.signal?.throwIfAborted();
  }

  async answerInteraction(input: {
    readonly interactionId: string;
    readonly text?: string;
    readonly showAlert?: boolean;
    readonly signal?: AbortSignal;
  }): Promise<void> {
    requiredDingTalkProviderId(input.interactionId, "interaction");
    input.signal?.throwIfAborted();
  }

  ownerAddress(): MessagingAddress {
    if (this.#ownerUserId === null) {
      throw invalidInput("The DingTalk owner has not claimed this connection yet.");
    }
    return dingTalkAddress({
      connectionId: this.connectionId,
      providerConversationId: this.#ownerUserId,
      group: false
    });
  }

  async close(): Promise<void> {
    await this.#stream.close();
    this.#api.close();
    this.#targets.clear();
    this.#downloadCodes.clear();
  }

  #rememberTransientCoordinates(
    updates: readonly DingTalkCallbackUpdate[],
    result: DingTalkNormalizationResult
  ): void {
    const admittedFileIds = new Set([
      ...result.events,
      ...result.interactionReplyCandidates
    ].flatMap((event) => event.kind === "message"
      ? event.attachments.map((attachment) => attachment.providerFileId)
      : []));
    const admittedAddresses = new Set([
      ...result.events.map((event) => addressKey(event.address)),
      ...result.interactionReplyCandidates.map((event) => addressKey(event.address)),
      ...result.groupObservations.map((observation) => addressKey(observation.address))
    ]);
    for (const update of updates) {
      const envelope = parseDingTalkEnvelope(update.payload, this.#now());
      if (envelope === null || envelope.robotCode !== this.#appKey) continue;
      const group = envelope.conversationType === "2";
      const address = dingTalkAddress({
        connectionId: this.connectionId,
        providerConversationId: group ? envelope.conversationId : envelope.senderId,
        group
      });
      if (!admittedAddresses.has(addressKey(address))) continue;
      this.#remember(this.#targets, addressKey(address), {
        kind: group ? "group" : "direct",
        id: address.providerConversationId,
        sessionWebhook: envelope.sessionWebhook,
        sessionWebhookExpiresAt: envelope.sessionWebhookExpiresAt
      });
      const content = parseDingTalkContent(envelope);
      content.attachments.forEach((part, index) => {
        const coordinate = dingTalkAttachmentCoordinate(envelope.messageId, index);
        if (admittedFileIds.has(coordinate)) this.#remember(this.#downloadCodes, coordinate, part.downloadCode);
      });
    }
  }

  #target(address: MessagingAddress): DingTalkOutboundTarget {
    this.#assertAddress(address);
    return this.#targets.get(addressKey(address)) ?? {
      kind: address.conversationKind === "direct" ? "direct" : "group",
      id: address.providerConversationId,
      sessionWebhook: null,
      sessionWebhookExpiresAt: null
    };
  }

  #assertAddress(address: MessagingAddress): void {
    if (address.channel !== "dingtalk" || address.connectionId !== this.connectionId) {
      throw invalidInput("DingTalk address does not belong to this connection.");
    }
    if (address.providerThreadId !== null || address.conversationKind === "channel") {
      throw invalidInput("DingTalk address has an unsupported conversation shape.");
    }
    requiredDingTalkProviderId(address.providerConversationId, "conversation");
  }

  #remember(map: Map<string, string>, key: string, value: string): void;
  #remember(map: Map<string, DingTalkOutboundTarget>, key: string, value: DingTalkOutboundTarget): void;
  #remember<T>(map: Map<string, T>, key: string, value: T): void {
    map.delete(key);
    map.set(key, value);
    while (map.size > MAXIMUM_TRANSIENT_COORDINATES) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }

  #requireProbe(): void {
    if (!this.#probed) throw invalidInput("Probe the DingTalk connection before using its Stream.");
  }
}

function formatInteractionPrompt(
  text: string,
  buttons: readonly { readonly label: string; readonly actionValue: string }[]
): string {
  const body = text.trim();
  if (body.length < 1) throw invalidInput("DingTalk interaction text is empty.");
  const choices = buttons.map((button, index) => {
    const label = button.label.replace(/[\u0000-\u001f\u007f]/gu, " ").trim();
    if (label.length < 1 || label.length > 80) throw invalidInput("DingTalk interaction choice label is invalid.");
    if (button.actionValue.length < 1 || button.actionValue.length > 256
      || /[\u0000-\u001f\u007f]/u.test(button.actionValue)) {
      throw invalidInput("DingTalk interaction choice value is invalid.");
    }
    return `${index + 1}. ${label}`;
  });
  const suffix = choices.length === 0 ? "" : `\n\nReply with a number or label:\n${choices.join("\n")}`;
  if (suffix.length >= DINGTALK_TEXT_LIMIT) {
    throw invalidInput(`DingTalk interaction choices exceed ${DINGTALK_TEXT_LIMIT} UTF-16 code units.`);
  }
  const maximumBody = DINGTALK_TEXT_LIMIT - suffix.length;
  const visibleBody = body.length <= maximumBody
    ? body
    : `${body.slice(0, Math.max(1, maximumBody - 24)).trimEnd()}\n\n[Open Joko for more]`;
  return `${visibleBody}${suffix}`;
}

function addressKey(address: MessagingAddress): string {
  return `${address.conversationKind}:${address.providerConversationId}`;
}

function requiredIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 256 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw invalidInput(`DingTalk ${label} identifier is invalid.`);
  }
  return normalized;
}

function requiredGeneration(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw invalidInput("DingTalk connection generation is invalid.");
  return value;
}

function invalidInput(message: string): MessagingTransportError {
  return new MessagingTransportError("invalid_input", message, { retryable: false, effect: "none" });
}
