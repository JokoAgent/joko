import { createHash, randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import type {
  MessagingAddress, MessagingConnectionProbe, MessagingDownloadedAttachment, MessagingGroupObservation,
  MessagingInboundAttachment, MessagingInboundMessage, MessagingReplyContext, MessagingSendReceipt
} from "../types.js";
import { isMessagingStopCommand } from "../task-commands.js";
import { BlueBubblesApi, blueBubblesFailure, MAXIMUM_IMESSAGE_ATTACHMENT_BYTES } from "./api.js";
import { iMessageAddress, iMessageChatGuid, parseIMessageConfiguration, type IMessageChatBinding, type IMessageConfiguration } from "./configuration.js";

const OVERLAP_MS = 5 * 60_000;
const MAXIMUM_HISTORY_ROWS = 10_000;
const HISTORY_PAGE_SIZE = 100;
const SEND_TEXT_BYTES = 32_000;
type Row = Record<string, unknown>;

export interface IMessageBatch {
  readonly events: readonly MessagingInboundMessage[];
  readonly groupObservations: readonly MessagingGroupObservation[];
  readonly interactionReplyCandidates: readonly MessagingInboundMessage[];
}

interface Chat {
  readonly binding: IMessageChatBinding;
  readonly displayName: string;
  readonly group: boolean;
  readonly participants: readonly { readonly address: string; readonly service: unknown }[];
}

export interface IMessageEcho {
  readonly chatGuid: string;
  readonly guid: string;
  readonly tempGuid?: string;
  readonly occurredAt: number;
  readonly text: string;
  readonly hasAttachments: boolean;
}

export interface IMessageTransportOptions {
  readonly connectionId: string;
  readonly generation: number;
  readonly ownerAddress: string;
  readonly configuration: IMessageConfiguration;
  readonly password: string;
  readonly initialActivation: number;
  readonly now?: () => number;
  readonly fetch?: typeof fetch;
  readonly pollIntervalMs?: number;
  readonly isOutgoing?: (echo: IMessageEcho) => boolean;
}

export function splitIMessageText(text: string): readonly string[] {
  const characters = [...text];
  const messages: string[] = [];
  // A Unicode scalar needs at most four UTF-8 bytes.
  const size = SEND_TEXT_BYTES / 4;
  for (let start = 0; start < characters.length; start += size) {
    const part = characters.slice(start, start + size).join("");
    if (part.trim()) messages.push(part);
  }
  return messages;
}

/** BlueBubbles accepts a client-generated UUID for the original outbound send. */
export function iMessageOutboundGuid(id: string): string {
  const value = createHash("sha256").update("joko-imessage:").update(id).digest("hex");
  return [value.slice(0, 8), value.slice(8, 12), "4" + value.slice(13, 16), "8" + value.slice(17, 20), value.slice(20, 32)].join("-");
}

export class IMessageTransport {
  readonly channel = "imessage" as const;
  readonly connectionId: string;
  readonly generation: number;
  readonly #owner: string;
  readonly #api: BlueBubblesApi;
  readonly #configuration: IMessageConfiguration;
  readonly #now: () => number;
  readonly #chats = new Map<string, Chat>();
  readonly #sent = new Set<string>();
  #privateGroups = false;

  constructor(private readonly options: IMessageTransportOptions) {
    this.connectionId = options.connectionId;
    this.generation = options.generation;
    const owner = iMessageAddress(options.ownerAddress);
    if (!owner) throw blueBubblesFailure("invalid_input", "Enter the iMessage owner address.");
    this.#owner = owner;
    this.#configuration = parseIMessageConfiguration(options.configuration);
    this.#api = new BlueBubblesApi(this.#configuration.serverOrigin, options.password, options.fetch);
    this.#now = options.now ?? Date.now;
  }

  async probe(signal?: AbortSignal): Promise<MessagingConnectionProbe> {
    const info = record(await this.#api.info(signal));
    if (!info) throw blueBubblesFailure("malformed_response", "BlueBubbles returned an invalid server record.");
    const chats = new Map<string, Chat>();
    for (const binding of this.#configuration.chats) {
      const native = record(await this.#api.chat(binding.guid, signal));
      const participants = Array.isArray(native?.["participants"]) ? native["participants"].flatMap((value: unknown) => {
        const part = record(value), address = iMessageAddress(part?.["address"]);
        return address ? [{ address, service: part?.["service"] }] : [];
      }) : [];
      const group = binding.guid.split(";")[1] === "+";
      if (native?.["guid"] !== binding.guid || participants.length === 0 || (!group && participants.length !== 1)
        || !participants.some(participant => participant.service === "iMessage")) {
        throw blueBubblesFailure("invalid_input", "An approved GUID did not resolve to its original iMessage chat.");
      }
      chats.set(binding.guid, { binding, displayName: boundedText(native["displayName"], 160) ?? "iMessage", group, participants });
    }
    this.#privateGroups = info["private_api"] === true && info["helper_connected"] === true;
    this.#chats.clear();
    for (const [guid, chat] of chats) this.#chats.set(guid, chat);
    return { channel: this.channel, connectionId: this.connectionId, generation: this.generation,
      providerAccountId: createHash("sha256").update(this.#configuration.serverOrigin).digest("hex"), displayName: "BlueBubbles", username: null };
  }

  ownerAddress(): MessagingAddress | undefined {
    const chat = [...this.#chats.values()].find(value => !value.group && value.participants[0]?.address === this.#owner);
    return chat ? this.#address(chat) : undefined;
  }

  async poll(input: { readonly cursor: string | null; readonly signal?: AbortSignal }): Promise<{ readonly nextCursor: string; readonly batch: IMessageBatch }> {
    const [activatedAt, scannedAt, checkpoint] = readCursor(input.cursor, this.options.initialActivation);
    await setTimeout(this.options.pollIntervalMs ?? 1_500, undefined, { signal: input.signal });
    const before = checkpoint?.before ?? Math.max(scannedAt, this.#now());
    const after = Math.max(0, activatedAt - 1, scannedAt - OVERLAP_MS);
    const candidates: { readonly chat: Chat; readonly message: Row; readonly time: number; readonly guid: string }[] = [];
    const chats = [...this.#chats.values()].filter(chat => !chat.group || chat.binding.activation !== "disabled");
    const start = checkpoint === undefined ? 0 : chats.findIndex(chat => chat.binding.guid === checkpoint.chat);
    if (start < 0) throw blueBubblesFailure("invalid_input", "The original iMessage cursor is invalid.");
    let nextCursor = JSON.stringify([activatedAt, before]);
    let count = 0;
    scan: for (let index = start; index < chats.length; index += 1) {
      const chat = chats[index]!;
      const resume = index === start ? checkpoint : undefined;
      // Seek within the last timestamp only after confirming the saved GUID
      // still occupies the saved position in the provider's mutable results.
      const chatAfter = resume?.time === undefined ? after : Math.max(after, resume.time - 1);
      const seen = new Set<string>();
      let time = resume?.time;
      let consumedAtTime = resume?.consumed ?? 0;
      let lastGuid = resume?.lastGuid;
      let anchor = lastGuid;
      let offset = Math.max(0, consumedAtTime - 1);
      for (;;) {
        if (count + HISTORY_PAGE_SIZE > MAXIMUM_HISTORY_ROWS) {
          nextCursor = JSON.stringify([activatedAt, scannedAt, { before, chat: chat.binding.guid,
            ...(time === undefined ? {} : { time, consumed: consumedAtTime, lastGuid }) }]);
          break scan;
        }
        const page = await this.#api.history(chat.binding.guid, chatAfter, before, offset, input.signal);
        if (!Array.isArray(page) || page.length > HISTORY_PAGE_SIZE) {
          throw blueBubblesFailure("malformed_response", "BlueBubbles could not enumerate its bounded message window.");
        }
        count += page.length;
        let startRow = 0;
        if (anchor !== undefined) {
          const first = record(page[0]);
          if (first?.["guid"] === anchor && first["dateCreated"] === time) {
            seen.add(anchor);
            startRow = 1;
          } else {
            // Replay the timestamp from zero if a deletion shifted the page.
            // The receiver already commits or deduplicates each message by GUID.
            time = lastGuid = undefined;
            consumedAtTime = 0;
            if (offset !== 0) {
              offset = 0;
              anchor = undefined;
              continue;
            }
          }
          anchor = undefined;
        }
        for (const value of page.slice(startRow)) {
          const message = record(value), guid = message?.["guid"], date = message?.["dateCreated"];
          if (!message || !isMessageGuid(guid) || typeof date !== "number" || !Number.isSafeInteger(date)
            || date <= chatAfter || date > before || time !== undefined && date < time || seen.has(guid)) {
            throw blueBubblesFailure("malformed_response", "BlueBubbles returned an invalid or repeated history entry.");
          }
          seen.add(guid);
          consumedAtTime = time === date ? consumedAtTime + 1 : 1;
          time = date;
          lastGuid = guid;
          if (date >= activatedAt) candidates.push({ chat, message, time: date, guid });
        }
        if (page.length < HISTORY_PAGE_SIZE) break;
        offset += HISTORY_PAGE_SIZE;
      }
    }
    candidates.sort((left, right) => left.time - right.time || left.guid.localeCompare(right.guid));
    const events: MessagingInboundMessage[] = [], interactionReplyCandidates: MessagingInboundMessage[] = [], groupObservations: MessagingGroupObservation[] = [];
    for (const candidate of candidates) {
      const { chat, message, time, guid } = candidate;
      const event = await this.#message(chat, message, guid, time, activatedAt, input.signal);
      if (!event) continue;
      if (chat.group) groupObservations.push({ address: event.address, messageId: guid, speaker: event.speaker, occurredAt: time,
        text: event.text, attachmentNames: event.attachments.map(attachment => attachment.fileName) });
      if (!event.ambient) events.push(event);
      else interactionReplyCandidates.push(event);
    }
    return { nextCursor, batch: { events, interactionReplyCandidates, groupObservations } };
  }

  async #message(chat: Chat, message: Row, guid: string, time: number, activatedAt: number, signal?: AbortSignal): Promise<MessagingInboundMessage | undefined> {
    const associations = messageChats(message);
    const route = associations.find(candidate => {
      const approved = this.#chats.get(candidate);
      return approved && (!approved.group || approved.binding.activation !== "disabled");
    });
    if (route !== chat.binding.guid || typeof message["isFromMe"] !== "boolean"
      || message["service"] !== undefined && message["service"] !== null && message["service"] !== "iMessage"
      || typeof message["associatedMessageType"] === "number" && message["associatedMessageType"] >= 2_000) return undefined;
    const handle = record(message["handle"]), fromMe = message["isFromMe"];
    const sender = iMessageAddress(handle?.["address"]) ?? (fromMe ? chat.binding.selfAddress : undefined);
    if (!sender || (handle ? handle["service"] !== "iMessage" : !fromMe || chat.participants.some(participant => participant.service !== "iMessage"))
      || !chat.group && !fromMe && chat.participants[0]?.address !== sender) return undefined;
    const text = boundedText(message["text"], 32_000) ?? "";
    const rawAttachments: unknown[] = Array.isArray(message["attachments"]) ? message["attachments"] : [];
    if (fromMe) {
      const tempGuid = isMessageGuid(message["tempGuid"]) ? message["tempGuid"] : undefined;
      if (chat.binding.selfAddress !== sender || this.#sent.has(guid) || tempGuid !== undefined && this.#sent.has(tempGuid)
        || associations.some(chatGuid => this.#chats.has(chatGuid) && this.options.isOutgoing?.({
          chatGuid, guid, tempGuid, occurredAt: time, text, hasAttachments: rawAttachments.length > 0
        }))) return undefined;
    }
    const attachments = rawAttachments.slice(0, 32).flatMap(value => {
      const parsed = inboundAttachment(value);
      return parsed ? [parsed] : [];
    });
    const unsupported = rawAttachments.length > attachments.length ? [{ code: "imessage_attachment", label: "An iMessage attachment was unavailable." }] : [];
    if (!text.trim() && !attachments.length && !unsupported.length) return undefined;
    const address = this.#address(chat);
    const replyGuid = message["threadOriginatorGuid"];
    const reply = isMessageGuid(replyGuid) && replyGuid !== guid ? await this.#reply(chat, replyGuid, activatedAt, signal) : undefined;
    for (const attachment of reply?.attachments ?? []) {
      if (attachments.length >= 32) break;
      if (attachments.every(existing => existing.providerFileId !== attachment.providerFileId)) attachments.push(attachment);
    }
    const invoked = this.#configuration.aliases.some(alias => new RegExp(`(?:^|\\s)@${alias.replace(/[.*+?^$(){}|[\]\\]/gu, "\\$&")}(?=$|[^\\p{L}\\p{N}_])`, "iu").test(text));
    const isOwner = sender === this.#owner && (!fromMe || this.ownerAddress()?.providerConversationId === chat.binding.guid);
    const ownerStop = isOwner && attachments.length === 0 && unsupported.length === 0 && isMessagingStopCommand(text);
    return {
      kind: "message", providerRequestIds: [`imessage:${createHash("sha256").update(chat.binding.guid).update("\0").update(guid).digest("hex")}`], messageId: guid,
      address, speaker: { providerUserId: sender, displayName: sender, username: null, isBot: false, isOwner },
      occurredAt: time, text, ambient: chat.group && chat.binding.activation === "mention" && !invoked && !ownerStop,
      protectedContent: false, attachments, unsupported, replyContext: reply?.context ?? null
    };
  }

  async #reply(chat: Chat, guid: string, activatedAt: number, signal?: AbortSignal): Promise<{
    readonly context: MessagingReplyContext; readonly attachments: readonly MessagingInboundAttachment[];
  } | undefined> {
    const message = record(await this.#api.message(guid, signal).catch(() => undefined));
    signal?.throwIfAborted();
    if (message?.["guid"] !== guid || !messageChats(message).includes(chat.binding.guid) || typeof message["dateCreated"] !== "number"
      || !Number.isSafeInteger(message["dateCreated"]) || message["dateCreated"] < activatedAt
      || message["service"] != null && message["service"] !== "iMessage") return undefined;
    const handle = record(message["handle"]);
    if (handle && handle["service"] !== "iMessage") return undefined;
    const author = iMessageAddress(handle?.["address"]) ?? (message["isFromMe"] === true ? "iMessage" : undefined);
    if (!author) return undefined;
    const raw: unknown[] = Array.isArray(message["attachments"]) ? message["attachments"] : [];
    return { context: { providerMessageId: guid, author, text: boundedText(message["text"], 4_000) ?? "",
      isBot: this.#sent.has(guid), attachmentCount: raw.length }, attachments: raw.slice(0, 10).flatMap(value => {
      const attachment = inboundAttachment(value);
      return attachment ? [attachment] : [];
    }) };
  }

  async downloadAttachment(attachment: MessagingInboundAttachment, signal?: AbortSignal): Promise<MessagingDownloadedAttachment> {
    if (!isMessageGuid(attachment.providerFileId)) throw blueBubblesFailure("invalid_input", "The iMessage attachment identity is invalid.");
    const bytes = await this.#api.download(attachment.providerFileId, signal);
    return { bytes, fileName: safeFileName(attachment.fileName), mimeType: attachment.mimeType ?? "application/octet-stream" };
  }

  async sendTextPart(input: { readonly address: MessagingAddress; readonly text: string; readonly deliveryId?: string;
    readonly assertCurrent?: () => void; readonly signal?: AbortSignal }): Promise<MessagingSendReceipt> {
    const { address, text, signal } = input;
    const chat = this.#outboundChat(address);
    if (!text.trim() || Buffer.byteLength(text) > SEND_TEXT_BYTES || text.includes("\0")) {
      throw blueBubblesFailure("invalid_input", "The iMessage text exceeds its supported bounds.");
    }
    input.assertCurrent?.();
    return this.#send(address, input.deliveryId,
      tempGuid => this.#api.sendText(chat.binding.guid, text, tempGuid, this.#method(chat), signal));
  }

  async sendAttachments(input: { readonly address: MessagingAddress; readonly deliveryId?: string; readonly assertCurrent?: () => void; readonly signal?: AbortSignal;
    readonly attachments: readonly { readonly bytes: Uint8Array; readonly fileName: string }[] }): Promise<MessagingSendReceipt> {
    const { address, signal } = input, chat = this.#outboundChat(address), file = input.attachments[0];
    if (input.attachments.length !== 1 || !file || file.bytes.byteLength <= 0 || file.bytes.byteLength > MAXIMUM_IMESSAGE_ATTACHMENT_BYTES) {
      throw blueBubblesFailure("invalid_input", "Send one iMessage attachment within its size limit.");
    }
    input.assertCurrent?.();
    return this.#send(address, input.deliveryId,
      tempGuid => this.#api.sendFile(chat.binding.guid, file.bytes, safeFileName(file.fileName), tempGuid, this.#method(chat), signal));
  }

  sendInteractionCard(input: { readonly address: MessagingAddress; readonly text: string; readonly deliveryId?: string;
    readonly buttons: readonly { readonly label: string }[]; readonly assertCurrent?: () => void; readonly signal?: AbortSignal }): Promise<MessagingSendReceipt> {
    const choices = input.buttons.map((button, index) => `${index + 1}. ${button.label}`).join("\n");
    return this.sendTextPart({ ...input, text: choices ? `${input.text}\n\n${choices}\n\nReply with the number.` : input.text });
  }

  async clearInteractionCard(input: { readonly address: MessagingAddress; readonly messageId: string }): Promise<MessagingSendReceipt> {
    return { address: input.address, providerMessageId: input.messageId };
  }

  async sendTyping(): Promise<void> {}
  async setReaction(): Promise<void> {}
  async answerInteraction(): Promise<void> {}

  #address(chat: Chat): MessagingAddress {
    return { channel: this.channel, connectionId: this.connectionId, providerConversationId: chat.binding.guid,
      providerThreadId: null, conversationKind: chat.group ? "group" : "direct" };
  }

  #outboundChat(address: MessagingAddress): Chat {
    const chat = this.#chats.get(address.providerConversationId);
    if (!chat || address.connectionId !== this.connectionId || address.channel !== this.channel || address.providerThreadId !== null
      || address.conversationKind !== (chat.group ? "group" : "direct")) {
      throw blueBubblesFailure("invalid_input", "The recipient is outside this iMessage connection.");
    }
    return chat;
  }

  #method(chat: Chat): "apple-script" | "private-api" {
    return chat.group && this.#privateGroups ? "private-api" : "apple-script";
  }

  async #send(address: MessagingAddress, deliveryId: string | undefined, action: (temporaryId: string) => Promise<unknown>): Promise<MessagingSendReceipt> {
    const tempGuid = deliveryId ? iMessageOutboundGuid(deliveryId) : randomUUID();
    this.#rememberSent(tempGuid);
    const result = record(await action(tempGuid)), guid = result?.["guid"];
    if (!isMessageGuid(guid)) throw blueBubblesFailure("malformed_response", "BlueBubbles did not confirm the sent message.", true);
    this.#rememberSent(guid);
    if (result?.["error"] != null && result["error"] !== 0 && result["error"] !== "0") {
      throw blueBubblesFailure("provider_rejected", "BlueBubbles reported a send failure.", true);
    }
    return { address, providerMessageId: guid };
  }

  #rememberSent(guid: string): void {
    this.#sent.add(guid);
    if (this.#sent.size > 2_000) this.#sent.delete(this.#sent.values().next().value!);
  }
}

interface HistoryCheckpoint {
  readonly before: number;
  readonly chat: string;
  readonly time?: number;
  readonly consumed?: number;
  readonly lastGuid?: string;
}

function readCursor(cursor: string | null, activation: number): readonly [number, number, HistoryCheckpoint?] {
  if (cursor === null) return [activation, activation];
  const value: unknown = JSON.parse(cursor);
  const invalid = () => blueBubblesFailure("invalid_input", "The original iMessage cursor is invalid.");
  if (!Array.isArray(value) || value.length < 2 || value.length > 3
    || !value.slice(0, 2).every(part => Number.isSafeInteger(part) && part >= 0) || value[1] < value[0]) throw invalid();
  if (value.length === 2) return [value[0], value[1]];
  const checkpoint = record(value[2]);
  const before = checkpoint?.["before"], chat = checkpoint?.["chat"], time = checkpoint?.["time"];
  const consumed = checkpoint?.["consumed"], lastGuid = checkpoint?.["lastGuid"];
  if (typeof before !== "number" || !Number.isSafeInteger(before) || before < value[1] || !iMessageChatGuid(chat)) throw invalid();
  if (time === undefined && consumed === undefined && lastGuid === undefined) return [value[0], value[1], { before, chat }];
  if (typeof time !== "number" || !Number.isSafeInteger(time) || time < value[0] || time > before
    || typeof consumed !== "number" || !Number.isSafeInteger(consumed) || consumed < 1 || !isMessageGuid(lastGuid)) {
    throw invalid();
  }
  return [value[0], value[1], { before, chat, time, consumed, lastGuid }];
}

function inboundAttachment(value: unknown): MessagingInboundAttachment | undefined {
  const row = record(value), guid = row?.["guid"], bytes = row?.["totalBytes"];
  if (!row || !isMessageGuid(guid) || typeof bytes === "number" && (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > MAXIMUM_IMESSAGE_ATTACHMENT_BYTES)) return undefined;
  const mimeType = typeof row["mimeType"] === "string" && /^[\w.+-]+\/[\w.+-]+$/u.test(row["mimeType"]) ? row["mimeType"] : null;
  const kind = mimeType?.startsWith("image/") ? "image" : "file";
  return { providerFileId: guid, providerUniqueFileId: guid, kind, fileName: safeFileName(boundedText(row["transferName"], 180) ?? "attachment"),
    mimeType, byteLength: typeof bytes === "number" ? bytes : null,
    ...(mimeType?.startsWith("audio/") ? { audioVideo: "audio" } : mimeType?.startsWith("video/") ? { audioVideo: "video" } : {}) };
}

function safeFileName(value: string): string {
  const filename = value.normalize("NFC").replace(/[/\\:*?"<>|\u0000-\u001f\u007f]/gu, "_").trim().replace(/^\.+/u, "").slice(0, 180);
  return filename || "attachment";
}

function messageChats(message: Row): string[] {
  if (!Array.isArray(message["chats"])) return [];
  return message["chats"].flatMap(chat => {
    const guid = record(chat)?.["guid"];
    return iMessageChatGuid(guid) ? [guid] : [];
  });
}

function isMessageGuid(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,256}$/u.test(value);
}

function boundedText(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" ? value.replace(/\0/gu, "").slice(0, maximum) : undefined;
}

function record(value: unknown): Row | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Row : undefined;
}
