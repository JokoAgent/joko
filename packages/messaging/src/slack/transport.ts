import type WebSocket from "ws";

import {
  MessagingTransportError,
  type MessagingAddress,
  type MessagingConnectionProbe,
  type MessagingDownloadedAttachment,
  type MessagingInboundAttachment,
  type MessagingSendReceipt
} from "../types.js";
import { SlackApi, type SlackApiOptions } from "./api.js";
import { decodeSlackAttachmentCoordinate, slackAddress, slackAddressParts, slackId, slackTimestamp } from "./codec.js";
import type { SlackOutboundAttachment, SlackPollResult, SlackSocketUpdate } from "./model.js";
import { normalizeSlackUpdates, SLACK_MAXIMUM_INBOUND_FILE_BYTES, type SlackNormalizationOptions, type SlackNormalizationResult } from "./normalize.js";
import { SlackSocketClient, type SlackSocketClientOptions } from "./socket.js";
import { safeSlackText, SLACK_TEXT_LIMIT } from "./text.js";

const SLACK_MAXIMUM_OUTBOUND_FILE_BYTES = 50 * 1024 * 1024;
const SLACK_MAXIMUM_CARD_BUTTONS = 25;
const ACK_REACTION = "👀";

export interface SlackTransportOptions extends SlackApiOptions {
  readonly connectionId: string;
  readonly generation: number;
  readonly ownerUserId: string;
  readonly groupActivation: SlackNormalizationOptions["groupActivation"];
  readonly initialCursor?: string | null;
  readonly now?: () => number;
  readonly maximumMessageAgeMs?: number;
  readonly createSocket?: (url: string) => WebSocket;
  readonly handshakeTimeoutMs?: number;
}

export interface SlackConnectionProbe extends MessagingConnectionProbe {
  readonly channel: "slack";
  readonly teamId: string;
  readonly botUserId: string;
  readonly ownerConversationId: string;
}

export class SlackTransport {
  readonly channel = "slack" as const;
  readonly connectionId: string;
  readonly generation: number;
  readonly #ownerUserId: string;
  readonly #groupActivation: SlackNormalizationOptions["groupActivation"];
  readonly #now: () => number;
  readonly #maximumMessageAgeMs: number | undefined;
  readonly #api: SlackApi;
  readonly #socket: SlackSocketClient;
  #teamId: string | null = null;
  #botUserId: string | null = null;
  #ownerConversationId: string | null = null;

  constructor(options: SlackTransportOptions) {
    this.connectionId = requiredIdentifier(options.connectionId, "connection");
    this.generation = requiredGeneration(options.generation);
    this.#ownerUserId = slackId(options.ownerUserId, "Slack owner user identifier");
    if (!/^[UW][A-Z0-9]{8,63}$/u.test(this.#ownerUserId)) throw invalid("Slack owner user identifier is invalid.");
    this.#groupActivation = validateGroupActivation(options.groupActivation);
    this.#now = options.now ?? Date.now;
    this.#maximumMessageAgeMs = options.maximumMessageAgeMs;
    this.#api = new SlackApi(options);
    this.#socket = new SlackSocketClient({
      openUrl: (signal) => this.#api.openSocketUrl(signal),
      ...(options.initialCursor === undefined ? {} : { initialCursor: options.initialCursor }),
      ...(options.createSocket === undefined ? {} : { createSocket: options.createSocket as SlackSocketClientOptions["createSocket"] }),
      ...(options.handshakeTimeoutMs === undefined ? {} : { handshakeTimeoutMs: options.handshakeTimeoutMs })
    });
  }

  async probe(signal?: AbortSignal): Promise<SlackConnectionProbe> {
    const identity = await this.#api.authTest(signal);
    const ownerDm = await this.#api.openOwnerDm(this.#ownerUserId, signal);
    try { await this.#socket.connect(signal); }
    catch (error) { await this.#socket.close().catch(() => undefined); throw error; }
    this.#teamId = identity.teamId;
    this.#botUserId = identity.botUserId;
    this.#ownerConversationId = ownerDm;
    return {
      channel: "slack",
      connectionId: this.connectionId,
      generation: this.generation,
      providerAccountId: identity.teamId,
      displayName: identity.teamName,
      username: null,
      teamId: identity.teamId,
      botUserId: identity.botUserId,
      ownerConversationId: ownerDm
    };
  }

  async poll(input: {
    readonly cursor: string | null;
    readonly timeoutSeconds?: number;
    readonly signal?: AbortSignal;
  }): Promise<SlackPollResult> {
    this.#requireProbe();
    return this.#socket.poll(input);
  }

  normalize(updates: readonly SlackSocketUpdate[]): SlackNormalizationResult {
    const { teamId, botUserId, ownerConversationId } = this.#requireProbe();
    return normalizeSlackUpdates(updates, {
      connectionId: this.connectionId,
      teamId,
      botUserId,
      ownerConversationId,
      ownerUserId: this.#ownerUserId,
      groupActivation: this.#groupActivation,
      now: this.#now,
      ...(this.#maximumMessageAgeMs === undefined ? {} : { maximumMessageAgeMs: this.#maximumMessageAgeMs })
    });
  }

  async acknowledge(envelopeId: string, signal?: AbortSignal): Promise<void> {
    this.#requireProbe();
    await this.#socket.acknowledge(envelopeId, signal);
  }

  ownerAddress(): MessagingAddress {
    const { teamId, ownerConversationId } = this.#requireProbe();
    return slackAddress({
      connectionId: this.connectionId,
      teamId,
      channelId: ownerConversationId,
      threadTs: null,
      direct: true
    });
  }

  async downloadAttachment(attachment: MessagingInboundAttachment, signal?: AbortSignal): Promise<MessagingDownloadedAttachment> {
    const { teamId } = this.#requireProbe();
    const coordinate = decodeSlackAttachmentCoordinate(attachment.providerFileId);
    if (coordinate.teamId !== teamId || coordinate.fileId !== attachment.providerUniqueFileId) {
      throw invalid("Slack attachment belongs to another connection.");
    }
    const file = await this.#api.fileInfo(coordinate.fileId, signal);
    const maximum = Math.min(
      attachment.byteLength ?? SLACK_MAXIMUM_INBOUND_FILE_BYTES,
      file.size ?? SLACK_MAXIMUM_INBOUND_FILE_BYTES,
      SLACK_MAXIMUM_INBOUND_FILE_BYTES
    );
    if (maximum < 1) throw invalid("Slack attachment size is invalid.");
    const result = await this.#api.downloadFile(file, maximum, signal);
    return { bytes: result.bytes, fileName: file.name, mimeType: file.mimeType ?? result.mimeType };
  }

  async sendTextPart(input: {
    readonly address: MessagingAddress;
    readonly text: string;
    readonly replyToMessageId?: string;
    readonly signal?: AbortSignal;
  }): Promise<MessagingSendReceipt> {
    const { channelId, threadTs } = this.#assertAddress(input.address);
    const text = safeSlackText(input.text);
    if (text.length < 1 || text.length > SLACK_TEXT_LIMIT) throw invalid("Slack text exceeds the per-message limit.");
    const providerMessageId = await this.#api.postMessage({
      channelId, text, threadTs: replyThreadTs(threadTs, input.replyToMessageId),
      ...(input.signal === undefined ? {} : { signal: input.signal })
    });
    return { providerMessageId, address: input.address };
  }

  async editTextPart(input: {
    readonly address: MessagingAddress;
    readonly messageId: string;
    readonly text: string;
    readonly signal?: AbortSignal;
  }): Promise<MessagingSendReceipt> {
    const { channelId } = this.#assertAddress(input.address);
    const text = safeSlackText(input.text);
    if (text.length < 1 || text.length > SLACK_TEXT_LIMIT) throw invalid("Slack edit text exceeds the per-message limit.");
    const providerMessageId = await this.#api.updateMessage({
      channelId,
      ts: slackTimestamp(input.messageId),
      text,
      ...(input.signal === undefined ? {} : { signal: input.signal })
    });
    return { providerMessageId, address: input.address };
  }

  async sendAttachments(input: {
    readonly address: MessagingAddress;
    readonly attachments: readonly SlackOutboundAttachment[];
    readonly replyToMessageId?: string;
    readonly signal?: AbortSignal;
  }): Promise<MessagingSendReceipt> {
    const { channelId, threadTs } = this.#assertAddress(input.address);
    if (input.attachments.length !== 1) throw invalid("Slack attachment delivery must contain exactly one file.");
    const attachment = input.attachments[0]!;
    if (!(attachment.bytes instanceof Uint8Array) || attachment.bytes.byteLength < 1 || attachment.bytes.byteLength > SLACK_MAXIMUM_OUTBOUND_FILE_BYTES) {
      throw new MessagingTransportError("payload_too_large", "Slack attachment exceeds the upload limit.", { retryable: false, effect: "none" });
    }
    if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(attachment.mimeType)) throw invalid("Slack attachment media type is invalid.");
    const providerMessageId = await this.#api.uploadFile({
      bytes: attachment.bytes,
      fileName: attachment.fileName,
      channelId, threadTs: replyThreadTs(threadTs, input.replyToMessageId),
      ...(input.signal === undefined ? {} : { signal: input.signal })
    });
    return { providerMessageId, address: input.address };
  }

  async sendInteractionCard(input: {
    readonly address: MessagingAddress;
    readonly text: string;
    readonly buttons: readonly { readonly label: string; readonly actionValue: string }[];
    readonly signal?: AbortSignal;
  }): Promise<MessagingSendReceipt> {
    const { channelId, threadTs } = this.#assertAddress(input.address);
    const cardText = input.text.trim();
    const text = safeSlackText(cardText);
    if (text.length < 1 || text.length > SLACK_TEXT_LIMIT) throw invalid("Slack interaction text is invalid.");
    if (input.buttons.length < 1 || input.buttons.length > SLACK_MAXIMUM_CARD_BUTTONS) throw invalid("Slack interaction button count is invalid.");
    const buttons = input.buttons.map((button) => {
      const label = button.label.trim();
      const actionValue = button.actionValue;
      if (label.length < 1 || label.length > 75 || /[\u0000-\u001f\u007f]/u.test(label)) throw invalid("Slack interaction button label is invalid.");
      if (actionValue.length < 1 || actionValue.length > 255 || /[\u0000-\u001f\u007f]/u.test(actionValue)) throw invalid("Slack interaction action is invalid.");
      return { type: "button", text: { type: "plain_text", text: label }, action_id: actionValue, value: actionValue };
    });
    const blocks: unknown[] = [{ type: "section", text: { type: "plain_text", text: cardText } }];
    for (let index = 0; index < buttons.length; index += 5) blocks.push({ type: "actions", elements: buttons.slice(index, index + 5) });
    const providerMessageId = await this.#api.postMessage({
      channelId, text, threadTs, blocks,
      ...(input.signal === undefined ? {} : { signal: input.signal })
    });
    return { providerMessageId, address: input.address };
  }

  async clearInteractionCard(input: {
    readonly address: MessagingAddress;
    readonly messageId: string;
    readonly signal?: AbortSignal;
  }): Promise<MessagingSendReceipt> {
    const { channelId } = this.#assertAddress(input.address);
    const providerMessageId = await this.#api.updateMessage({
      channelId,
      ts: slackTimestamp(input.messageId),
      text: "This request is closed.",
      ...(input.signal === undefined ? {} : { signal: input.signal })
    });
    return { providerMessageId, address: input.address };
  }

  async setReaction(input: {
    readonly address: MessagingAddress;
    readonly messageId: string;
    readonly emoji: string | null;
    readonly signal?: AbortSignal;
  }): Promise<void> {
    const { channelId } = this.#assertAddress(input.address);
    if (input.emoji === null) await this.#api.removeReaction(channelId, input.messageId, ACK_REACTION, input.signal);
    else await this.#api.addReaction(channelId, input.messageId, input.emoji, input.signal);
  }

  async sendTyping(address: MessagingAddress, signal?: AbortSignal): Promise<void> {
    this.#assertAddress(address);
    signal?.throwIfAborted();
    // Socket Mode has no bot typing method in the Web API.
  }

  async answerInteraction(input: { readonly interactionId: string; readonly text?: string; readonly showAlert?: boolean; readonly signal?: AbortSignal }): Promise<void> {
    input.signal?.throwIfAborted();
    if (!input.interactionId.startsWith("slack:action:")) throw invalid("Slack interaction identifier is invalid.");
    // Socket envelope acknowledgement is owned by acknowledge() after durable admission.
  }

  async close(): Promise<void> { await this.#socket.close(); }

  #assertAddress(address: MessagingAddress): { readonly channelId: string; readonly threadTs: string | null } {
    const { teamId } = this.#requireProbe();
    return slackAddressParts(address, this.connectionId, teamId);
  }

  #requireProbe(): { readonly teamId: string; readonly botUserId: string; readonly ownerConversationId: string } {
    if (this.#teamId === null || this.#botUserId === null || this.#ownerConversationId === null) {
      throw invalid("Probe the Slack connection before using its transport.");
    }
    return { teamId: this.#teamId, botUserId: this.#botUserId, ownerConversationId: this.#ownerConversationId };
  }
}

function validateGroupActivation(value: SlackTransportOptions["groupActivation"]): SlackTransportOptions["groupActivation"] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalid("Slack channel activation is invalid.");
  for (const [channelId, activation] of Object.entries(value)) {
    if (!/^[CG][A-Z0-9]{8,63}$/u.test(channelId) || !["mention", "always", "disabled"].includes(activation)) {
      throw invalid("Slack channel activation is invalid.");
    }
  }
  return { ...value };
}

function requiredIdentifier(value: string, label: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (normalized.length < 1 || normalized.length > 256 || /[\u0000-\u001f\u007f]/u.test(normalized)) throw invalid(`Slack ${label} identifier is invalid.`);
  return normalized;
}
function requiredGeneration(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw invalid("Slack generation is invalid.");
  return value;
}
function replyThreadTs(rootThreadTs: string | null, replyToMessageId: string | undefined): string | null {
  // Channel replies always stay under their existing root. A DM can instead
  // use the exact native parent ts; synthetic slash-command IDs are not posts.
  if (rootThreadTs !== null) return rootThreadTs;
  return replyToMessageId !== undefined && /^\d{1,16}\.\d{1,9}$/u.test(replyToMessageId)
    ? replyToMessageId : null;
}
function invalid(message: string): MessagingTransportError {
  return new MessagingTransportError("invalid_input", message, { retryable: false, effect: "none" });
}
