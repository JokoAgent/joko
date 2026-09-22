import { MessagingTransportError } from "@joko/messaging";
import type { OrchestratorApplicationDependencies } from "@joko/orchestrator";

type MessagingChannel = "telegram" | "discord" | "dingtalk" | "feishu" | "lark" | "wecom" | "wechat" | "slack";

type MessagingAddress = {
  readonly channel: MessagingChannel;
  readonly connectionId: string;
  readonly providerConversationId: string;
  readonly providerThreadId: string | null;
  readonly conversationKind: "direct" | "group" | "channel";
};

type MessagingSpeaker = {
  readonly providerUserId: string;
  readonly displayName: string;
  readonly username: null;
  readonly isBot: boolean;
  readonly isOwner: boolean;
};

type MessagingInboundAttachment = {
  readonly providerFileId: string;
  readonly providerUniqueFileId: null;
  readonly kind: "image" | "file";
  readonly fileName: string;
  readonly mimeType: string | null;
  readonly byteLength: number | null;
};

type FixtureInboundMessage = {
  readonly kind: "message";
  readonly providerRequestIds: readonly string[];
  readonly messageId: string;
  readonly address: MessagingAddress;
  readonly speaker: MessagingSpeaker;
  readonly occurredAt: number;
  readonly text: string;
  readonly ambient: boolean;
  readonly protectedContent: boolean;
  readonly attachments: readonly MessagingInboundAttachment[];
  readonly unsupported: readonly { readonly code: string; readonly label: string }[];
  readonly replyContext: null;
};

type FixtureNormalizationResult = {
  readonly events: readonly FixtureInboundMessage[];
  readonly interactionReplyCandidates: readonly FixtureInboundMessage[];
  readonly groupObservations: readonly {
    readonly address: MessagingAddress;
    readonly messageId: string;
    readonly speaker: MessagingSpeaker;
    readonly occurredAt: number;
    readonly text: string;
    readonly attachmentNames: readonly string[];
  }[];
  readonly ignored: readonly {
    readonly providerRequestId: string;
    readonly reason: "unauthorized" | "unaddressed" | "unsupported_update";
    readonly providerConversationId: string | null;
    readonly providerUserId: string | null;
  }[];
  readonly ownerClaimProviderUserId: string | null;
};

type FixtureMediaKind = "image" | "file" | "video";

interface StoredAttachment {
  readonly providerKey: string;
  readonly mediaKind: FixtureMediaKind;
  readonly bytes: Uint8Array;
  readonly fileName: string;
  readonly mimeType: string;
}

interface FixtureFrame {
  readonly kind: "message";
  readonly messageId: string;
  readonly conversationId: string;
  readonly conversationKind: "direct" | "group";
  readonly senderId: string;
  readonly senderName: string;
  readonly text: string;
  readonly occurredAt: number;
  readonly media: readonly {
    readonly providerKey: string;
    readonly mediaKind: FixtureMediaKind;
    readonly transportUrl: string;
    readonly aesKey: string;
  }[];
  readonly voiceTranscript: string | null;
}

interface FixtureUpdate {
  readonly callbackId: string;
  readonly receivedAt: number;
  readonly frame: FixtureFrame;
}

type WeComTransportFactory = NonNullable<
  OrchestratorApplicationDependencies["messagingCreateWeComTransport"]
>;
type WeComTransportOptions = Parameters<WeComTransportFactory>[0];

export const WECOM_SYSTEM_BOT_ID = "wecom-joko-system-bot";
export const WECOM_SYSTEM_BOT_SECRET = "wecom-system-bot-secret";
export const WECOM_SYSTEM_OWNER_ID = "wecom-owner-1";
export const WECOM_SYSTEM_GROUP_ID = "wecom-owner-group";
export const WECOM_SYSTEM_PRIVATE_FRAME = "wecom-private-frame-payload";
export const WECOM_SYSTEM_PRIVATE_URL = "https://private.invalid/wecom-media";
export const WECOM_SYSTEM_PRIVATE_AES_KEY = "wecom-private-aes-key";

export interface WeComSystemOutboundText {
  readonly address: MessagingAddress;
  readonly text: string;
  readonly providerMessageId: string;
  readonly callbackMessageId?: string;
}

/**
 * Independent WeCom provider-boundary fixture. It models provider poll/cursor,
 * callback reply start, media download and outbound effects without importing
 * the production WeCom parser or normalizer.
 */
export class WeComSystemFixture {
  readonly outboundTexts: WeComSystemOutboundText[] = [];
  readonly outboundAttachments: Array<{
    readonly address: MessagingAddress;
    readonly fileNames: readonly string[];
  }> = [];
  readonly interactionCards: Array<{
    readonly address: MessagingAddress;
    readonly text: string;
    readonly buttons: readonly { readonly label: string; readonly actionValue: string }[];
    readonly providerMessageId: string;
  }> = [];
  readonly beginReplies: string[] = [];
  readonly effects: string[] = [];
  readonly createTransport: WeComTransportFactory;
  readonly #updates: FixtureUpdate[] = [];
  readonly #attachments = new Map<string, StoredAttachment>();
  readonly #waiters = new Set<() => void>();
  #nextOutbound = 1;
  #transportStarts = 0;
  #disconnectPending = false;

  constructor() {
    this.createTransport = (options) => new WeComSystemTransport(this, options);
  }

  get transportStarts(): number {
    return this.#transportStarts;
  }

  addAttachment(input: StoredAttachment): void {
    if (input.providerKey.trim() === "" || input.fileName.trim() === "" || input.bytes.byteLength === 0) {
      throw new Error("WeCom fixture attachment is invalid.");
    }
    this.#attachments.set(input.providerKey, { ...input, bytes: input.bytes.slice() });
  }

  enqueueDirectMedia(input: {
    readonly callbackMessageId: string;
    readonly messageId: string;
    readonly text: string;
    readonly providerKeys: readonly string[];
    readonly voiceTranscript: string;
  }): void {
    this.#enqueue(input.callbackMessageId, {
      kind: "message",
      messageId: input.messageId,
      conversationId: WECOM_SYSTEM_OWNER_ID,
      conversationKind: "direct",
      senderId: WECOM_SYSTEM_OWNER_ID,
      senderName: "WeCom owner",
      text: `${input.text}\n${WECOM_SYSTEM_PRIVATE_FRAME}`,
      occurredAt: Date.now(),
      voiceTranscript: input.voiceTranscript,
      media: input.providerKeys.map((providerKey) => {
        const stored = this.#attachments.get(providerKey);
        if (stored === undefined) throw new Error(`Unknown WeCom fixture attachment ${providerKey}.`);
        return {
          providerKey,
          mediaKind: stored.mediaKind,
          transportUrl: `${WECOM_SYSTEM_PRIVATE_URL}/${encodeURIComponent(providerKey)}`,
          aesKey: WECOM_SYSTEM_PRIVATE_AES_KEY
        };
      })
    });
  }

  enqueueDirectText(input: {
    readonly callbackMessageId: string;
    readonly messageId: string;
    readonly text: string;
  }): void {
    this.#enqueue(input.callbackMessageId, {
      kind: "message",
      messageId: input.messageId,
      conversationId: WECOM_SYSTEM_OWNER_ID,
      conversationKind: "direct",
      senderId: WECOM_SYSTEM_OWNER_ID,
      senderName: "WeCom owner",
      text: input.text,
      occurredAt: Date.now(),
      voiceTranscript: null,
      media: []
    });
  }

  enqueueOwnerGroupText(input: {
    readonly callbackMessageId: string;
    readonly messageId: string;
    readonly text: string;
  }): void {
    this.#enqueue(input.callbackMessageId, {
      kind: "message",
      messageId: input.messageId,
      conversationId: WECOM_SYSTEM_GROUP_ID,
      conversationKind: "group",
      senderId: WECOM_SYSTEM_OWNER_ID,
      senderName: "WeCom owner",
      text: input.text,
      occurredAt: Date.now(),
      voiceTranscript: null,
      media: []
    });
  }

  enqueueOtherGroupText(input: {
    readonly callbackMessageId: string;
    readonly messageId: string;
    readonly text: string;
    readonly senderId?: string;
  }): void {
    this.#enqueue(input.callbackMessageId, {
      kind: "message",
      messageId: input.messageId,
      conversationId: WECOM_SYSTEM_GROUP_ID,
      conversationKind: "group",
      senderId: input.senderId ?? "wecom-other-user",
      senderName: "Other WeCom user",
      text: input.text,
      occurredAt: Date.now(),
      voiceTranscript: null,
      media: []
    });
  }

  forceRetryableDisconnect(): void {
    this.#disconnectPending = true;
    this.#wake();
  }

  updatesAfter(cursor: string | null): readonly FixtureUpdate[] {
    if (cursor === null || cursor === "connected") return this.#updates;
    const index = this.#updates.findIndex((update) => update.callbackId === cursor);
    if (index < 0) throw new Error("WeCom fixture cursor is unknown.");
    return this.#updates.slice(index + 1);
  }

  attachment(providerKey: string): StoredAttachment | undefined {
    return this.#attachments.get(providerKey);
  }

  consumeDisconnect(): boolean {
    if (!this.#disconnectPending) return false;
    this.#disconnectPending = false;
    return true;
  }

  transportStarted(): void {
    this.#transportStarts += 1;
  }

  nextProviderMessageId(prefix: string): string {
    return `${prefix}-${this.#nextOutbound++}`;
  }

  async wait(signal: AbortSignal | undefined, timeoutMs: number): Promise<void> {
    signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        this.#waiters.delete(wake);
        if (error === undefined) resolve();
        else reject(error);
      };
      const wake = () => finish();
      const abort = () => finish(new DOMException("WeCom fixture poll was cancelled.", "AbortError"));
      const timer = setTimeout(wake, timeoutMs);
      this.#waiters.add(wake);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted === true) abort();
    });
  }

  #enqueue(callbackMessageId: string, frame: FixtureFrame): void {
    this.#updates.push({ callbackId: `wecom:callback:${callbackMessageId}`, receivedAt: Date.now(), frame });
    this.#wake();
  }

  #wake(): void {
    for (const waiter of [...this.#waiters]) waiter();
  }
}

class WeComSystemTransport {
  readonly channel = "wecom" as const;
  readonly connectionId: string;
  readonly generation: number;
  readonly #fixture: WeComSystemFixture;
  readonly #options: WeComTransportOptions;
  readonly #attachmentCoordinates = new Map<string, string>();
  #ownerUserId: string | null;
  #closed = false;

  constructor(fixture: WeComSystemFixture, options: WeComTransportOptions) {
    this.#fixture = fixture;
    this.#options = options;
    this.connectionId = options.connectionId;
    this.generation = options.generation;
    this.#ownerUserId = options.ownerUserId;
    fixture.transportStarted();
  }

  async probe(signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (this.#options.botId !== WECOM_SYSTEM_BOT_ID || this.#options.botSecret !== WECOM_SYSTEM_BOT_SECRET) {
      throw new Error("WeCom fixture rejected the bot identity or secret.");
    }
    return {
      channel: "wecom" as const,
      connectionId: this.connectionId,
      generation: this.generation,
      providerAccountId: WECOM_SYSTEM_BOT_ID,
      displayName: "Joko WeCom system bot",
      username: null
    };
  }

  async poll(input: {
    readonly cursor: string | null;
    readonly timeoutSeconds?: number;
    readonly signal?: AbortSignal;
  }) {
    this.#assertOpen();
    if (this.#fixture.consumeDisconnect()) throw retryableDisconnect();
    let updates = this.#fixture.updatesAfter(input.cursor);
    if (updates.length === 0) {
      await this.#fixture.wait(input.signal, Math.max(1, input.timeoutSeconds ?? 1) * 1_000);
      if (this.#fixture.consumeDisconnect()) throw retryableDisconnect();
      updates = this.#fixture.updatesAfter(input.cursor);
    }
    const batch = updates.slice(0, 100);
    return {
      updates: batch as never,
      nextCursor: batch.at(-1)?.callbackId ?? input.cursor ?? "connected"
    };
  }

  normalize(updates: readonly unknown[]): FixtureNormalizationResult {
    const events: FixtureInboundMessage[] = [];
    const ignored: FixtureNormalizationResult["ignored"][number][] = [];
    const groupObservations: FixtureNormalizationResult["groupObservations"][number][] = [];
    let ownerClaimProviderUserId: string | null = null;
    for (const raw of updates) {
      if (!isFixtureUpdate(raw)) continue;
      const frame = raw.frame;
      if (frame.conversationKind === "direct" && this.#ownerUserId === null) {
        this.#ownerUserId = frame.senderId;
        ownerClaimProviderUserId = frame.senderId;
      }
      const isOwner = frame.senderId === this.#ownerUserId;
      const address: MessagingAddress = {
        channel: "wecom",
        connectionId: this.connectionId,
        providerConversationId: frame.conversationId,
        providerThreadId: null,
        conversationKind: frame.conversationKind
      };
      const speaker: MessagingSpeaker = {
        providerUserId: frame.senderId,
        displayName: frame.senderName,
        username: null,
        isBot: false,
        isOwner
      };
      if (!isOwner) {
        ignored.push({
          providerRequestId: raw.callbackId,
          reason: "unauthorized",
          providerConversationId: frame.conversationId,
          providerUserId: frame.senderId
        });
        continue;
      }
      const attachments = frame.media.map((media, index): MessagingInboundAttachment => {
        const stored = this.#fixture.attachment(media.providerKey);
        if (stored === undefined) throw new Error("WeCom fixture media is unavailable.");
        const providerFileId = `${frame.messageId}:${index}`;
        this.#attachmentCoordinates.set(providerFileId, media.providerKey);
        return {
          providerFileId,
          providerUniqueFileId: null,
          kind: stored.mediaKind === "image" ? "image" : "file",
          fileName: stored.fileName,
          mimeType: stored.mimeType,
          byteLength: stored.bytes.byteLength
        };
      });
      const mediaText = frame.media.map((media) => `[${media.mediaKind}]`).join(" ");
      const recognizedVoice = frame.voiceTranscript === null ? "" : `\n[voice transcript] ${frame.voiceTranscript}`;
      const event: FixtureInboundMessage = {
        kind: "message",
        providerRequestIds: [raw.callbackId],
        messageId: frame.messageId,
        address,
        speaker,
        occurredAt: frame.occurredAt,
        text: `${frame.text.replace(WECOM_SYSTEM_PRIVATE_FRAME, "").trim()}${mediaText === "" ? "" : `\n${mediaText}`}${recognizedVoice}`,
        ambient: false,
        protectedContent: false,
        attachments,
        unsupported: [],
        replyContext: null
      };
      events.push(event);
      if (frame.conversationKind === "group") {
        groupObservations.push({
          address,
          messageId: frame.messageId,
          speaker,
          occurredAt: frame.occurredAt,
          text: event.text,
          attachmentNames: attachments.map((attachment) => attachment.fileName)
        });
      }
    }
    return {
      events,
      interactionReplyCandidates: events,
      groupObservations,
      ignored,
      ownerClaimProviderUserId
    };
  }

  async downloadAttachment(attachment: MessagingInboundAttachment) {
    const providerKey = this.#attachmentCoordinates.get(attachment.providerFileId);
    const stored = providerKey === undefined ? undefined : this.#fixture.attachment(providerKey);
    if (stored === undefined) throw new Error("WeCom fixture attachment coordinate is unavailable.");
    this.#fixture.effects.push(`download:${stored.mediaKind}`);
    return { bytes: stored.bytes.slice(), fileName: stored.fileName, mimeType: stored.mimeType };
  }

  async beginReply(input: { readonly messageId: string; readonly signal?: AbortSignal }): Promise<void> {
    input.signal?.throwIfAborted();
    this.#fixture.beginReplies.push(input.messageId);
    this.#fixture.effects.push(`begin:${input.messageId}`);
  }

  async sendTextPart(input: {
    readonly address: MessagingAddress;
    readonly text: string;
    readonly replyToMessageId?: string;
    readonly callbackMessageId?: string;
    readonly signal?: AbortSignal;
  }) {
    this.#assertAddress(input.address);
    input.signal?.throwIfAborted();
    const providerMessageId = this.#fixture.nextProviderMessageId("wecom-text");
    this.#fixture.outboundTexts.push({
      address: input.address,
      text: input.text,
      providerMessageId,
      ...(input.callbackMessageId === undefined ? {} : { callbackMessageId: input.callbackMessageId })
    });
    this.#fixture.effects.push(`text:${providerMessageId}`);
    return { providerMessageId, address: input.address };
  }

  async sendAttachments(input: {
    readonly address: MessagingAddress;
    readonly attachments: readonly { readonly fileName: string }[];
    readonly signal?: AbortSignal;
  }) {
    this.#assertAddress(input.address);
    input.signal?.throwIfAborted();
    this.#fixture.outboundAttachments.push({
      address: input.address,
      fileNames: input.attachments.map((attachment) => attachment.fileName)
    });
    return { providerMessageId: this.#fixture.nextProviderMessageId("wecom-file"), address: input.address };
  }

  async sendInteractionCard(input: {
    readonly address: MessagingAddress;
    readonly text: string;
    readonly buttons: readonly { readonly label: string; readonly actionValue: string }[];
    readonly signal?: AbortSignal;
  }) {
    this.#assertAddress(input.address);
    input.signal?.throwIfAborted();
    const providerMessageId = this.#fixture.nextProviderMessageId("wecom-interaction");
    this.#fixture.interactionCards.push({ ...input, providerMessageId });
    this.#fixture.effects.push(`interaction:${providerMessageId}`);
    return { providerMessageId, address: input.address };
  }

  async clearInteractionCard(input: { readonly address: MessagingAddress; readonly messageId: string }) {
    this.#assertAddress(input.address);
    return { providerMessageId: input.messageId, address: input.address };
  }

  async sendTyping(): Promise<void> {}
  async setReaction(): Promise<void> {}
  async answerInteraction(): Promise<void> {}

  ownerAddress(): MessagingAddress {
    if (this.#ownerUserId === null) throw new Error("WeCom fixture owner is not claimed.");
    return {
      channel: "wecom",
      connectionId: this.connectionId,
      providerConversationId: this.#ownerUserId,
      providerThreadId: null,
      conversationKind: "direct"
    };
  }

  async close(): Promise<void> {
    this.#closed = true;
  }

  #assertAddress(address: MessagingAddress): void {
    if (address.channel !== "wecom" || address.connectionId !== this.connectionId) {
      throw new Error("WeCom fixture address belongs to another transport.");
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new DOMException("WeCom fixture transport is closed.", "AbortError");
  }
}

function retryableDisconnect(): MessagingTransportError {
  return new MessagingTransportError("network", "WeCom fixture retryable disconnect.", {
    retryable: true,
    effect: "none"
  });
}

function isFixtureUpdate(value: unknown): value is FixtureUpdate {
  return isRecord(value) && typeof value["callbackId"] === "string" && typeof value["receivedAt"] === "number"
    && isRecord(value["frame"]) && value["frame"]["kind"] === "message";
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
