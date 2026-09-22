import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MessagingTransportError,
  type DiscordGatewayUpdate,
  type DiscordNormalizationResult,
  type DiscordPollResult,
  type DiscordTransportOptions,
  type MessagingAddress,
  type MessagingDownloadedAttachment,
  type MessagingInboundAttachment,
  type TelegramNormalizationResult,
  type TelegramPollResult,
  type TelegramTransportOptions,
  type TelegramUpdate
} from "@joko/messaging";
import type { AdapterContext, InteractionDecision, MessageBlock, PromptInput } from "@joko/core";
import { OperationalStore } from "@joko/store";
import { FakeBackendAdapter, PI_LIKE_PROFILE } from "@joko/testkit";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OperationalArtifactRepository } from "./artifact-repository.js";
import { ArtifactStore } from "./artifact-store.js";
import { CredentialManager } from "./credential-manager.js";
import { CredentialVault } from "./credential-vault.js";
import {
  DEFAULT_DISCORD_MESSAGING_CONFIGURATION,
  DEFAULT_TELEGRAM_MESSAGING_CONFIGURATION,
  MessagingManager,
  type MessagingManagerOptions
} from "./messaging-manager.js";
import { SessionHost } from "./session-host.js";
import { mkdtempSync } from "./test-paths.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("MessagingManager", () => {
  it("binds one-shot credential tickets to the exact client, channel revision and generation, then retires replaced secrets", async () => {
    const fixture = await createFixture();
    const created = fixture.manager.createTelegramConnection({ ownerProviderUserId: "42" });

    const staleTicket = fixture.manager.beginCredentialUpload({
      clientConnectionId: "desktop-one",
      messagingConnectionId: created.id,
      expectedRevision: created.revision,
      expectedGeneration: created.generation
    });
    expect(() => fixture.credentials.upload(staleTicket.credentialUploadTicketId, token("stale"), "desktop-two"))
      .toThrow("different connection");
    fixture.credentials.upload(staleTicket.credentialUploadTicketId, token("stale"), "desktop-one");
    await expect(fixture.credentials.commitUpload({
      credentialUploadTicketId: staleTicket.credentialUploadTicketId,
      displayName: "Repurposed credential",
      kind: "api_key",
      connectionId: "desktop-one"
    })).rejects.toThrow("cannot be committed");
    const changed = await fixture.manager.replaceTelegramConfiguration({
      connectionId: created.id,
      expectedRevision: created.revision,
      expectedGeneration: created.generation,
      configuration: { ...DEFAULT_TELEGRAM_MESSAGING_CONFIGURATION, emojiReactions: "off" },
      ownerProviderUserId: "42"
    });
    await expect(fixture.manager.commitCredential({
      credentialUploadTicketId: staleTicket.credentialUploadTicketId,
      clientConnectionId: "desktop-one",
      enable: false
    })).rejects.toMatchObject({ code: "conflict" });

    const first = await replaceCredential(fixture, changed, "first");
    const firstReference = first.credentialReferenceId!;
    expect(fixture.credentials.resolve(firstReference)).toBe(token("first"));
    const second = await replaceCredential(fixture, first, "second");
    expect(second.credentialReferenceId).not.toBe(firstReference);
    expect(fixture.credentials.find(firstReference)).toBeUndefined();
    expect(fixture.credentials.resolve(second.credentialReferenceId!)).toBe(token("second"));

    const cleared = await fixture.manager.clearCredential({
      connectionId: second.id,
      expectedRevision: second.revision,
      expectedGeneration: second.generation
    });
    expect(cleared.enabled).toBe(false);
    expect(cleared.credentialReferenceId).toBeUndefined();
    expect(cleared.ownerProviderUserId).toBe("42");
    expect(fixture.credentials.find(second.credentialReferenceId!)).toBeUndefined();
    expect(fixture.store.findSetting("service", "orchestrator", "messaging.credential-journal")?.value)
      .toEqual({ format: 1, references: [] });
    expect(fixture.manager.beginCredentialUpload({
      clientConnectionId: "desktop-one",
      messagingConnectionId: cleared.id,
      expectedRevision: cleared.revision,
      expectedGeneration: cleared.generation
    }).credentialUploadTicketId).toBeTruthy();
  });

  it("does not rewrite the connection revision for unchanged empty long polls", async () => {
    const transport = new StableEmptyTelegramTransport();
    const fixture = await createFixture(() => transport);
    const created = fixture.manager.createTelegramConnection({ ownerProviderUserId: "42" });
    const enabled = await replaceCredential(fixture, created, "stable-poll", true);

    await vi.waitFor(() => {
      expect(fixture.store.getMessagingConnection(enabled.id)).toMatchObject({
        runtimeStatus: "connected",
        cursor: "1"
      });
    });
    const stableRevision = fixture.store.getMessagingConnection(enabled.id).revision;
    await vi.waitFor(() => expect(transport.polls).toBeGreaterThanOrEqual(10));
    expect(fixture.store.getMessagingConnection(enabled.id).revision).toBe(stableRevision);
  });

  it("does not advance Telegram offset until a missing route is fixed and the inbound request is atomically Queue-bound", async () => {
    const transport = new FakeTelegramTransport(directMessageBatch());
    const fixture = await createFixture(() => transport);
    const created = fixture.manager.createTelegramConnection({ ownerProviderUserId: "42" });
    const enabled = await replaceCredential(fixture, created, "inbound", true);

    await vi.waitFor(() => {
      expect(fixture.store.listMessagingInboundRequests()).toHaveLength(1);
      const current = fixture.store.getMessagingConnection(enabled.id);
      expect(current.cursor).toBeUndefined();
      expect(current).toMatchObject({ runtimeStatus: "error", errorCode: "processing_failed" });
    });
    const preparing = fixture.store.listMessagingInboundRequests()[0]!;
    expect(preparing.status).toBe("preparing");
    expect(preparing.queueItemId).toBeUndefined();

    fixture.manager.putRoute({
      targetId: "target-one",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    });
    await vi.waitFor(() => {
      expect(fixture.store.getMessagingConnection(enabled.id).cursor).toBe("10");
      expect(fixture.store.getMessagingInboundRequest(preparing.id).status).toBe("completed");
    });
    const admitted = fixture.store.getMessagingInboundRequest(preparing.id);
    expect(admitted).toMatchObject({
      operationId: `messaging-input-${preparing.id}`,
      protectedContent: false
    });
    expect(admitted.runId).toBeDefined();
    expect(admitted.attemptId).toBeDefined();
    expect(admitted.queueItemId).toBeDefined();
    expect(fixture.store.getQueueItem(admitted.queueItemId!)).toMatchObject({
      sessionId: fixture.store.getMessagingConversation(admitted.conversationId!).sessionId,
      operationId: admitted.operationId
    });
    expect(transport.typing).toHaveLength(1);
    await vi.waitFor(() => expect(transport.sentText.length).toBeGreaterThan(0));
    expect(transport.sentText.some((entry) => entry.text.includes("Reply from fake"))).toBe(true);
    await vi.waitFor(() => {
      expect(fixture.store.listMessagingDeliveries().every((delivery) => delivery.status === "sent")).toBe(true);
    }, { timeout: 2_000 });
  });

  it("keeps an uncertain outbound Telegram effect unknown and never sends it again after reconnect", async () => {
    const transport = new FakeTelegramTransport(directMessageBatch(), { failFirstTextUnknown: true });
    const fixture = await createFixture(() => transport);
    fixture.manager.putRoute({
      targetId: "target-one",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    });
    const created = fixture.manager.createTelegramConnection({
      ownerProviderUserId: "42",
      configuration: { ...DEFAULT_TELEGRAM_MESSAGING_CONFIGURATION, emojiReactions: "off" }
    });
    await replaceCredential(fixture, created, "unknown", true);

    await vi.waitFor(() => {
      const deliveries = fixture.store.listMessagingDeliveries();
      expect(deliveries.some((delivery) => delivery.kind === "text" && delivery.status === "unknown")).toBe(true);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(transport.textAttempts).toBe(1);
    expect(fixture.store.listMessagingDeliveries({ statuses: ["pending", "dispatching"] })).toEqual([]);
  });

  it("settles an album across getUpdates pages before atomically advancing the durable cursor", async () => {
    const transport = new CrossPollAlbumTransport();
    const fixture = await createFixture(() => transport);
    fixture.manager.putRoute({
      targetId: "target-one",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    });
    const created = fixture.manager.createTelegramConnection({
      ownerProviderUserId: "42",
      configuration: { ...DEFAULT_TELEGRAM_MESSAGING_CONFIGURATION, emojiReactions: "off" }
    });
    const enabled = await replaceCredential(fixture, created, "album", true);

    await vi.waitFor(() => {
      expect(fixture.store.getMessagingConnection(enabled.id).cursor).toBe("11");
      expect(fixture.store.listMessagingInboundRequests()).toHaveLength(1);
    });
    expect(transport.normalizedUpdateIds).toEqual([[9, 10]]);
    expect(transport.polls.slice(0, 3)).toEqual([
      { cursor: null, timeoutSeconds: 0 },
      { cursor: "10", timeoutSeconds: 1 },
      { cursor: "11", timeoutSeconds: 1 }
    ]);
    expect(new Set(fixture.store.listMessagingInboundRequests()[0]!.providerRequestIds)).toEqual(new Set([
      "telegram-update:9",
      "telegram-update:10"
    ]));
  });

  it("delivers verified assistant images as one album and other artifacts as individual files", async () => {
    const transport = new FakeTelegramTransport(directMessageBatch());
    const adapter = new AttachmentFakeAdapter();
    const fixture = await createFixture(() => transport, () => adapter);
    const first = await fixture.artifacts.ingestBytes(new Uint8Array([1, 2, 3]), {
      fileName: "one.png",
      mimeType: "image/png"
    });
    const second = await fixture.artifacts.ingestBytes(new Uint8Array([4, 5, 6]), {
      fileName: "two.png",
      mimeType: "image/png"
    });
    const document = await fixture.artifacts.ingestBytes(new TextEncoder().encode("private-document-body"), {
      fileName: "report.txt",
      mimeType: "text/plain"
    });
    adapter.blocks = [
      { kind: "text", text: "Files are ready." },
      { kind: "image", blob: first, alt: "First image" },
      { kind: "image", blob: second, alt: "Second image" },
      { kind: "artifact", blob: document, label: "report.txt" }
    ];
    fixture.manager.putRoute({
      targetId: "target-one",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    });
    const created = fixture.manager.createTelegramConnection({
      ownerProviderUserId: "42",
      configuration: { ...DEFAULT_TELEGRAM_MESSAGING_CONFIGURATION, emojiReactions: "off" }
    });
    await replaceCredential(fixture, created, "files", true);

    await vi.waitFor(() => expect(transport.sentAttachments).toEqual([
      { address: expect.objectContaining({ providerConversationId: "42" }), fileNames: ["one.png", "two.png"] },
      { address: expect.objectContaining({ providerConversationId: "42" }), fileNames: ["report.txt"] }
    ]));
    const fileDeliveries = fixture.store.listMessagingDeliveries().filter((delivery) => delivery.kind === "file");
    expect(fileDeliveries).toHaveLength(2);
    expect(fileDeliveries.every((delivery) => delivery.status === "sent")).toBe(true);
    const durableText = JSON.stringify(fileDeliveries, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value);
    expect(durableText).not.toContain("1,2,3");
    expect(durableText).not.toContain("private-document-body");
  });

  it("projects an open permission to a durable Telegram card and resolves its owner callback once", async () => {
    const transport = new InteractiveTelegramTransport();
    const adapter = new PermissionFakeAdapter();
    const fixture = await createFixture(() => transport, () => adapter);
    fixture.manager.putRoute({
      targetId: "target-one",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    });
    const created = fixture.manager.createTelegramConnection({
      ownerProviderUserId: "42",
      configuration: { ...DEFAULT_TELEGRAM_MESSAGING_CONFIGURATION, emojiReactions: "off" }
    });
    await replaceCredential(fixture, created, "interaction", true);

    await vi.waitFor(() => expect(adapter.decision).toEqual({ kind: "selected", value: "allow_once" }));
    expect(transport.sentInteractionCards).toHaveLength(1);
    expect(transport.sentInteractionCards[0]).toMatchObject({
      text: expect.stringContaining("Run command"),
      buttons: [
        { label: "allow_once", actionValue: expect.any(String) },
        { label: "deny_once", actionValue: expect.any(String) }
      ]
    });
    await vi.waitFor(() => expect(transport.interactionAnswers).toEqual([
      { text: "Response recorded.", showAlert: false },
      { text: "This action is no longer available.", showAlert: true }
    ]));
    const coreInteraction = fixture.store.getInteraction("permission-one");
    expect(coreInteraction).toMatchObject({
      status: "resolved",
      decision: { kind: "selected", value: "allow_once" }
    });
    expect(fixture.store.listMessagingDeliveries().find((delivery) => delivery.kind === "interaction"))
      .toMatchObject({ status: "sent", providerMessageId: "card-1" });
    expect(fixture.store.listMessagingInteractions()).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "completed", providerInteractionId: "callback-one" }),
      expect.objectContaining({ status: "failed", providerInteractionId: "callback-two", outcomeCode: "stale_action" })
    ]));
    await vi.waitFor(() => expect(transport.clearedInteractionCards).toEqual([
      { address: expect.objectContaining({ providerConversationId: "42" }), messageId: "card-1" }
    ]));
    expect(fixture.store.listMessagingDeliveries().filter((delivery) => delivery.kind === "interaction"))
      .toHaveLength(2);
  });

  it("resolves a typed multi-field question from an exact Telegram reply without admitting another Queue turn", async () => {
    const transport = new QuestionReplyTelegramTransport();
    const adapter = new QuestionFakeAdapter();
    const fixture = await createFixture(() => transport, () => adapter);
    fixture.manager.putRoute({
      targetId: "target-one",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    });
    const created = fixture.manager.createTelegramConnection({
      ownerProviderUserId: "42",
      configuration: { ...DEFAULT_TELEGRAM_MESSAGING_CONFIGURATION, emojiReactions: "off" }
    });
    await replaceCredential(fixture, created, "question", true);

    await vi.waitFor(() => expect(adapter.decision).toEqual({
      kind: "question",
      answers: {
        name: { kind: "text", value: "Alice" },
        mode: { kind: "single", selection: { kind: "choice", choiceId: "safe" } },
        extras: { kind: "multiple", choiceIds: ["logs", "tests"] },
        confirm: { kind: "boolean", value: true }
      }
    }));
    expect(transport.sentInteractionCards).toEqual([
      expect.objectContaining({
        text: expect.stringContaining("name: <answer>"),
        buttons: []
      })
    ]);
    await vi.waitFor(() => {
      expect(transport.sentText.some((entry) =>
        entry.text === "Response recorded." && entry.replyToMessageId === "79")).toBe(true);
      expect(transport.sentText.some((entry) =>
        entry.text.includes("value for mode") && entry.replyToMessageId === "78")).toBe(true);
    });
    expect(transport.clearedInteractionCards).toEqual([]);
    expect(fixture.store.listMessagingInboundRequests()).toHaveLength(1);
    expect(fixture.store.getInteraction("question-one")).toMatchObject({ status: "resolved" });
    const callbacks = fixture.store.listMessagingInteractions();
    expect(callbacks).toHaveLength(2);
    expect(callbacks).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "failed", providerMessageId: "78", outcomeCode: "invalid_response" }),
      expect.objectContaining({ status: "completed", providerMessageId: "79" })
    ]));
    expect(JSON.stringify(callbacks, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value))
      .not.toContain("Alice");
  });

  it("runs Discord through the same durable admission and effect ledger, including lifecycle disconnect", async () => {
    const transport = new FakeDiscordTransport();
    const fixture = await createFixture(undefined, undefined, () => transport);
    fixture.manager.putRoute({
      targetId: "target-one",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    });
    const created = fixture.manager.createDiscordConnection({
      ownerProviderUserId: "111111111111111111",
      configuration: DEFAULT_DISCORD_MESSAGING_CONFIGURATION
    });
    const enabled = await replaceCredential(fixture, created, "discord", true);

    await vi.waitFor(() => {
      const runtime = fixture.store.getMessagingConnection(enabled.id);
      if (runtime.runtimeStatus === "error") {
        throw new Error(`${runtime.errorCode ?? "unknown"}: ${runtime.errorSummary ?? "unknown"}`);
      }
      expect(runtime).toMatchObject({
        channel: "discord",
        runtimeStatus: "connected",
        cursor: "discord-cursor-1"
      });
      expect(fixture.store.listMessagingInboundRequests()).toHaveLength(1);
      expect(transport.sentText.some((entry) => entry.text.includes("Reply from fake"))).toBe(true);
      expect(transport.reactions.map((entry) => entry.emoji)).toEqual(["👀", null, "✅"]);
    });
    expect(transport.initialCursor).toBeNull();
    expect(transport.sentText[0]).toMatchObject({
      text: "Joko is connected and ready on Discord.",
      address: { channel: "discord", providerConversationId: "444444444444444444" }
    });
    expect(fixture.store.listMessagingDeliveries()).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "notice", status: "sent" }),
      expect.objectContaining({ kind: "text", status: "sent" })
    ]));

    const current = fixture.store.getMessagingConnection(enabled.id);
    const disabled = await fixture.manager.setEnabled({
      connectionId: current.id,
      expectedRevision: current.revision,
      expectedGeneration: current.generation,
      enabled: false
    });
    expect(disabled.enabled).toBe(false);
    expect(transport.sentText.some((entry) => entry.text === "Joko's Discord connection is being disabled.")).toBe(true);
    expect(fixture.store.listMessagingDeliveries().filter((delivery) => delivery.kind === "notice"))
      .toHaveLength(2);
  });

  it("projects terminal Discord Gateway credential loss without retrying the retired worker", async () => {
    const transport = new AuthLossDiscordTransport();
    const fixture = await createFixture(undefined, undefined, () => transport);
    const created = fixture.manager.createDiscordConnection({
      ownerProviderUserId: "111111111111111111",
      configuration: { ...DEFAULT_DISCORD_MESSAGING_CONFIGURATION, lifecycleAnnouncements: false }
    });
    const enabled = await replaceCredential(fixture, created, "discord-auth-loss", true);

    await vi.waitFor(() => expect(fixture.store.getMessagingConnection(enabled.id)).toMatchObject({
      runtimeStatus: "auth_loss",
      errorCode: "invalid_credential",
      errorSummary: "Discord rejected the managed credential."
    }));
    expect(transport.polls).toBe(1);
  });
});

class FakeTelegramTransport {
  readonly channel = "telegram" as const;
  readonly connectionId = "";
  readonly generation = 0;
  readonly sentText: Array<{
    readonly address: MessagingAddress;
    readonly text: string;
    readonly replyToMessageId?: string;
  }> = [];
  readonly sentAttachments: Array<{ readonly address: MessagingAddress; readonly fileNames: readonly string[] }> = [];
  readonly sentInteractionCards: Array<{
    readonly address: MessagingAddress;
    readonly text: string;
    readonly buttons: readonly { readonly label: string; readonly actionValue: string }[];
  }> = [];
  readonly clearedInteractionCards: Array<{ readonly address: MessagingAddress; readonly messageId: string }> = [];
  readonly interactionAnswers: Array<{ readonly text: string; readonly showAlert: boolean }> = [];
  readonly typing: MessagingAddress[] = [];
  readonly reactions: Array<{ readonly messageId: string; readonly emoji: string | null }> = [];
  textAttempts = 0;
  #boundConnectionId = "";
  #boundGeneration = 0;

  constructor(
    readonly batch: TelegramNormalizationResult,
    readonly options: { readonly failFirstTextUnknown?: boolean } = {}
  ) {}

  bind(options: TelegramTransportOptions): this {
    this.#boundConnectionId = options.connectionId;
    this.#boundGeneration = options.generation;
    Object.defineProperties(this, {
      connectionId: { value: options.connectionId },
      generation: { value: options.generation }
    });
    return this;
  }

  async probe() {
    return {
      channel: "telegram" as const,
      connectionId: this.#boundConnectionId,
      generation: this.#boundGeneration,
      providerAccountId: "9001",
      displayName: "Joko test bot",
      username: "joko_test_bot"
    };
  }

  async poll(input: { readonly cursor: string | null; readonly signal?: AbortSignal }): Promise<TelegramPollResult> {
    if (input.cursor === null) return { updates: [{ update_id: 9 }], nextCursor: "10" };
    return waitForAbort(input.signal);
  }

  normalize(_updates: readonly TelegramUpdate[]): TelegramNormalizationResult {
    return {
      ...this.batch,
      events: this.batch.events.map((event) => ({
        ...event,
        address: { ...event.address, connectionId: this.#boundConnectionId }
      })),
      groupObservations: this.batch.groupObservations.map((observation) => ({
        ...observation,
        address: { ...observation.address, connectionId: this.#boundConnectionId }
      }))
    };
  }

  async downloadAttachment(_attachment: MessagingInboundAttachment): Promise<MessagingDownloadedAttachment> {
    throw new Error("No attachment was expected.");
  }

  async sendTextPart(input: {
    readonly address: MessagingAddress;
    readonly text: string;
    readonly replyToMessageId?: string;
  }) {
    this.textAttempts += 1;
    if (this.options.failFirstTextUnknown === true && this.textAttempts === 1) {
      throw new MessagingTransportError("network", "uncertain test effect", {
        retryable: true,
        effect: "unknown"
      });
    }
    this.sentText.push({
      address: input.address,
      text: input.text,
      ...(input.replyToMessageId === undefined ? {} : { replyToMessageId: input.replyToMessageId })
    });
    return { providerMessageId: `sent-${this.textAttempts}`, address: input.address };
  }

  async sendAttachments(input: {
    readonly address: MessagingAddress;
    readonly attachments: readonly { readonly fileName: string }[];
  }) {
    this.sentAttachments.push({ address: input.address, fileNames: input.attachments.map((value) => value.fileName) });
    return { providerMessageId: `file-${this.sentAttachments.length}`, address: input.address };
  }

  async sendInteractionCard(input: {
    readonly address: MessagingAddress;
    readonly text: string;
    readonly buttons: readonly { readonly label: string; readonly actionValue: string }[];
  }) {
    this.sentInteractionCards.push(input);
    return { providerMessageId: `card-${this.sentInteractionCards.length}`, address: input.address };
  }

  async clearInteractionCard(input: { readonly address: MessagingAddress; readonly messageId: string }) {
    this.clearedInteractionCards.push({ address: input.address, messageId: input.messageId });
    return { providerMessageId: input.messageId, address: input.address };
  }

  async sendTyping(address: MessagingAddress): Promise<void> {
    this.typing.push(address);
  }

  async setReaction(input: { readonly messageId: string; readonly emoji: string | null }): Promise<void> {
    this.reactions.push({ messageId: input.messageId, emoji: input.emoji });
  }

  async answerInteraction(input: {
    readonly interactionId: string;
    readonly text?: string;
    readonly showAlert?: boolean;
    readonly signal?: AbortSignal;
  }): Promise<void> {
    this.interactionAnswers.push({ text: input.text ?? "", showAlert: input.showAlert ?? false });
  }
}

class StableEmptyTelegramTransport extends FakeTelegramTransport {
  polls = 0;

  constructor() {
    super({ events: [], groupObservations: [], ignored: [] });
  }

  override async poll(input: { readonly cursor: string | null; readonly signal?: AbortSignal }): Promise<TelegramPollResult> {
    this.polls += 1;
    await new Promise((resolve) => setTimeout(resolve, 1));
    input.signal?.throwIfAborted();
    return { updates: [], nextCursor: input.cursor ?? "1" };
  }
}

class FakeDiscordTransport {
  readonly channel = "discord" as const;
  readonly connectionId = "";
  readonly generation = 0;
  readonly sentText: Array<{
    readonly address: MessagingAddress;
    readonly text: string;
    readonly replyToMessageId?: string;
  }> = [];
  readonly reactions: Array<{ readonly messageId: string; readonly emoji: string | null }> = [];
  readonly initialCursor: string | null = null;
  #boundConnectionId = "";
  #boundGeneration = 0;

  bind(options: DiscordTransportOptions): this {
    this.#boundConnectionId = options.connectionId;
    this.#boundGeneration = options.generation;
    Object.defineProperties(this, {
      connectionId: { value: options.connectionId },
      generation: { value: options.generation },
      initialCursor: { value: options.initialCursor ?? null }
    });
    return this;
  }

  async probe() {
    return {
      channel: "discord" as const,
      connectionId: this.#boundConnectionId,
      generation: this.#boundGeneration,
      providerAccountId: "222222222222222222",
      displayName: "Joko Discord test bot",
      username: "joko_test_bot",
      ownerConversationId: "444444444444444444"
    };
  }

  async poll(input: { readonly cursor: string | null; readonly signal?: AbortSignal }): Promise<DiscordPollResult> {
    if (input.cursor === null) {
      return {
        updates: [{
          sequence: 1,
          eventType: "MESSAGE_CREATE",
          message: {
            id: "999999999999999991",
            channel_id: "444444444444444444",
            author: { id: "111111111111111111", username: "owner" },
            content: "Hello from Discord",
            timestamp: new Date().toISOString()
          },
          channel: { id: "444444444444444444", type: 1 }
        }],
        nextCursor: "discord-cursor-1"
      };
    }
    return waitForAbort(input.signal);
  }

  normalize(_updates: readonly DiscordGatewayUpdate[]): DiscordNormalizationResult {
    return {
      events: [{
        kind: "message",
        providerRequestIds: ["discord:message:999999999999999991"],
        messageId: "999999999999999991",
        address: this.ownerAddress(),
        speaker: {
          providerUserId: "111111111111111111",
          displayName: "Owner",
          username: "owner",
          isBot: false,
          isOwner: true
        },
        occurredAt: Date.now(),
        text: "Hello from Discord",
        ambient: false,
        protectedContent: false,
        attachments: [],
        unsupported: [],
        replyContext: null
      }],
      groupObservations: [],
      ignored: []
    };
  }

  ownerAddress(): MessagingAddress {
    return {
      channel: "discord",
      connectionId: this.#boundConnectionId,
      providerConversationId: "444444444444444444",
      providerThreadId: null,
      conversationKind: "direct"
    };
  }

  async downloadAttachment(_attachment: MessagingInboundAttachment): Promise<MessagingDownloadedAttachment> {
    throw new Error("No attachment was expected.");
  }

  async sendTextPart(input: {
    readonly address: MessagingAddress;
    readonly text: string;
    readonly replyToMessageId?: string;
  }) {
    this.sentText.push({
      address: input.address,
      text: input.text,
      ...(input.replyToMessageId === undefined ? {} : { replyToMessageId: input.replyToMessageId })
    });
    return { providerMessageId: `discord-sent-${this.sentText.length}`, address: input.address };
  }

  async sendAttachments(input: { readonly address: MessagingAddress }) {
    return { providerMessageId: "discord-file", address: input.address };
  }

  async sendInteractionCard(input: { readonly address: MessagingAddress }) {
    return { providerMessageId: "discord-card", address: input.address };
  }

  async clearInteractionCard(input: { readonly address: MessagingAddress; readonly messageId: string }) {
    return { providerMessageId: input.messageId, address: input.address };
  }

  async sendTyping(): Promise<void> {}
  async setReaction(input: { readonly messageId: string; readonly emoji: string | null }): Promise<void> {
    this.reactions.push({ messageId: input.messageId, emoji: input.emoji });
  }
  async answerInteraction(): Promise<void> {}
  async close(): Promise<void> {}
}

class AuthLossDiscordTransport extends FakeDiscordTransport {
  polls = 0;

  override async poll(): Promise<DiscordPollResult> {
    this.polls += 1;
    throw new MessagingTransportError("invalid_credential", "fixture credential rejected", {
      retryable: false,
      effect: "none"
    });
  }
}

class InteractiveTelegramTransport extends FakeTelegramTransport {
  #releaseInteractionPoll: (() => void) | undefined;
  #releaseStalePoll: (() => void) | undefined;

  constructor() {
    super(directMessageBatch());
  }

  override async poll(input: {
    readonly cursor: string | null;
    readonly signal?: AbortSignal;
  }): Promise<TelegramPollResult> {
    if (input.cursor === null) return { updates: [{ update_id: 9 }], nextCursor: "10" };
    if (input.cursor === "10") {
      if (this.sentInteractionCards.length === 0) {
        await new Promise<void>((resolve, reject) => {
          this.#releaseInteractionPoll = resolve;
          const abort = () => reject(new MessagingTransportError("cancelled", "test poll cancelled", {
            retryable: false,
            effect: "none"
          }));
          if (input.signal?.aborted) abort();
          else input.signal?.addEventListener("abort", abort, { once: true });
        });
      }
      return { updates: [{ update_id: 10 }], nextCursor: "11" };
    }
    if (input.cursor === "11") {
      if (this.clearedInteractionCards.length === 0) {
        await new Promise<void>((resolve, reject) => {
          this.#releaseStalePoll = resolve;
          const abort = () => reject(new MessagingTransportError("cancelled", "test poll cancelled", {
            retryable: false,
            effect: "none"
          }));
          if (input.signal?.aborted) abort();
          else input.signal?.addEventListener("abort", abort, { once: true });
        });
      }
      return { updates: [{ update_id: 11 }], nextCursor: "12" };
    }
    return waitForAbort(input.signal);
  }

  override normalize(updates: readonly TelegramUpdate[]): TelegramNormalizationResult {
    const callbackUpdate = updates.find((update) => update.update_id === 10 || update.update_id === 11);
    if (callbackUpdate !== undefined) {
      const card = this.sentInteractionCards[0];
      if (card === undefined) throw new Error("Interaction card was not sent before its callback.");
      return {
        events: [{
          kind: "interaction",
          providerRequestIds: [`telegram-update:${callbackUpdate.update_id}`],
          interactionId: callbackUpdate.update_id === 10 ? "callback-one" : "callback-two",
          messageId: "card-1",
          address: card.address,
          speaker: {
            providerUserId: "42",
            displayName: "Owner",
            username: "owner",
            isBot: false,
            isOwner: true
          },
          actionValue: card.buttons[0]!.actionValue,
          occurredAt: Date.now()
        }],
        groupObservations: [],
        ignored: []
      };
    }
    return super.normalize(updates);
  }

  override async sendInteractionCard(input: {
    readonly address: MessagingAddress;
    readonly text: string;
    readonly buttons: readonly { readonly label: string; readonly actionValue: string }[];
  }) {
    const receipt = await super.sendInteractionCard(input);
    this.#releaseInteractionPoll?.();
    this.#releaseInteractionPoll = undefined;
    return receipt;
  }

  override async clearInteractionCard(input: { readonly address: MessagingAddress; readonly messageId: string }) {
    const receipt = await super.clearInteractionCard(input);
    this.#releaseStalePoll?.();
    this.#releaseStalePoll = undefined;
    return receipt;
  }
}

class QuestionReplyTelegramTransport extends FakeTelegramTransport {
  #releaseReplyPoll: (() => void) | undefined;

  constructor() {
    super(directMessageBatch());
  }

  override async poll(input: {
    readonly cursor: string | null;
    readonly signal?: AbortSignal;
  }): Promise<TelegramPollResult> {
    if (input.cursor === null) return { updates: [{ update_id: 9 }], nextCursor: "10" };
    if (input.cursor === "10") {
      if (this.sentInteractionCards.length === 0) {
        await new Promise<void>((resolve, reject) => {
          this.#releaseReplyPoll = resolve;
          const abort = () => reject(new MessagingTransportError("cancelled", "test poll cancelled", {
            retryable: false,
            effect: "none"
          }));
          if (input.signal?.aborted) abort();
          else input.signal?.addEventListener("abort", abort, { once: true });
        });
      }
      return { updates: [{ update_id: 10 }], nextCursor: "11" };
    }
    if (input.cursor === "11") return { updates: [{ update_id: 11 }], nextCursor: "12" };
    return waitForAbort(input.signal);
  }

  override normalize(updates: readonly TelegramUpdate[]): TelegramNormalizationResult {
    const replyUpdate = updates.find((update) => update.update_id === 10 || update.update_id === 11);
    if (replyUpdate !== undefined) {
      const card = this.sentInteractionCards[0];
      if (card === undefined) throw new Error("Question card was not sent before its reply.");
      const valid = replyUpdate.update_id === 11;
      return {
        events: [{
          kind: "message",
          providerRequestIds: [`telegram-update:${replyUpdate.update_id}`],
          messageId: valid ? "79" : "78",
          address: card.address,
          speaker: {
            providerUserId: "42",
            displayName: "Owner",
            username: "owner",
            isBot: false,
            isOwner: true
          },
          occurredAt: Date.now(),
          text: valid
            ? "name: Alice\nmode: Safe\nextras: Logs, Tests\nconfirm: yes"
            : "name: Alice",
          ambient: false,
          protectedContent: false,
          attachments: [],
          unsupported: [],
          replyContext: {
            providerMessageId: "card-1",
            author: "Joko test bot",
            text: card.text,
            isBot: true,
            attachmentCount: 0
          }
        }],
        groupObservations: [],
        ignored: []
      };
    }
    return super.normalize(updates);
  }

  override async sendInteractionCard(input: {
    readonly address: MessagingAddress;
    readonly text: string;
    readonly buttons: readonly { readonly label: string; readonly actionValue: string }[];
  }) {
    const receipt = await super.sendInteractionCard(input);
    this.#releaseReplyPoll?.();
    this.#releaseReplyPoll = undefined;
    return receipt;
  }
}

class CrossPollAlbumTransport extends FakeTelegramTransport {
  readonly polls: Array<{ readonly cursor: string | null; readonly timeoutSeconds?: number }> = [];
  readonly normalizedUpdateIds: number[][] = [];
  #settleSilenceReturned = false;

  constructor() {
    const batch = directMessageBatch();
    super({
      ...batch,
      events: batch.events.map((event) => ({
        ...event,
        providerRequestIds: ["telegram-update:9", "telegram-update:10"]
      }))
    });
  }

  override async poll(input: {
    readonly cursor: string | null;
    readonly timeoutSeconds?: number;
    readonly signal?: AbortSignal;
  }): Promise<TelegramPollResult> {
    this.polls.push({ cursor: input.cursor, timeoutSeconds: input.timeoutSeconds });
    if (input.cursor === null) return { updates: [albumUpdate(9, 81)], nextCursor: "10" };
    if (input.cursor === "10") return { updates: [albumUpdate(10, 82)], nextCursor: "11" };
    if (input.cursor === "11" && !this.#settleSilenceReturned) {
      this.#settleSilenceReturned = true;
      return { updates: [], nextCursor: "11" };
    }
    return waitForAbort(input.signal);
  }

  override normalize(updates: readonly TelegramUpdate[]): TelegramNormalizationResult {
    this.normalizedUpdateIds.push(updates.map((update) => update.update_id));
    return super.normalize(updates);
  }
}

class AttachmentFakeAdapter extends FakeBackendAdapter {
  blocks: readonly MessageBlock[] = [{ kind: "text", text: "Files are ready." }];

  constructor() {
    super(PI_LIKE_PROFILE);
  }

  override async send(_input: PromptInput, context: AdapterContext): Promise<void> {
    queueMicrotask(() => void (async () => {
      await context.emit({ type: "message_complete", role: "assistant", blocks: this.blocks });
      await context.emit({ type: "done", outcome: "completed" });
    })());
  }
}

class PermissionFakeAdapter extends FakeBackendAdapter {
  decision: InteractionDecision | undefined;

  constructor() {
    super(PI_LIKE_PROFILE);
  }

  override async send(_input: PromptInput, context: AdapterContext): Promise<void> {
    queueMicrotask(() => void (async () => {
      this.decision = await context.requestInteraction({
        id: "permission-one",
        kind: "permission",
        title: "Run command",
        toolName: "shell",
        summary: "Run the approved command.",
        risk: "high",
        choices: ["allow_once", "deny_once"]
      });
      await context.emit({
        type: "message_complete",
        role: "assistant",
        blocks: [{ kind: "text", text: `Decision: ${this.decision.kind}` }]
      });
      await context.emit({ type: "done", outcome: "completed" });
    })());
  }
}

class QuestionFakeAdapter extends FakeBackendAdapter {
  decision: InteractionDecision | undefined;

  constructor() {
    super(PI_LIKE_PROFILE);
  }

  override async send(_input: PromptInput, context: AdapterContext): Promise<void> {
    queueMicrotask(() => void (async () => {
      this.decision = await context.requestInteraction({
        id: "question-one",
        kind: "question",
        title: "Configure the run",
        prompt: "Answer every required field.",
        fields: [{
          id: "name",
          label: "Display name",
          required: true,
          kind: "text",
          multiline: false
        }, {
          id: "mode",
          label: "Mode",
          required: true,
          kind: "single",
          choices: [{ id: "fast", label: "Fast" }, { id: "safe", label: "Safe" }],
          allowOther: false
        }, {
          id: "extras",
          label: "Extras",
          required: true,
          kind: "multiple",
          choices: [{ id: "logs", label: "Logs" }, { id: "tests", label: "Tests" }],
          defaultChoiceIds: [],
          minimumSelections: 1,
          maximumSelections: 2,
          allowOther: false
        }, {
          id: "confirm",
          label: "Confirm",
          required: true,
          kind: "boolean",
          defaultValue: false
        }]
      });
      await context.emit({
        type: "message_complete",
        role: "assistant",
        blocks: [{ kind: "text", text: `Question: ${this.decision.kind}` }]
      });
      await context.emit({ type: "done", outcome: "completed" });
    })());
  }
}

async function createFixture(
  transportFactory?: (options: TelegramTransportOptions) => FakeTelegramTransport,
  adapterFactory?: () => FakeBackendAdapter,
  discordTransportFactory?: (options: DiscordTransportOptions) => FakeDiscordTransport
) {
  const root = mkdtempSync(join(tmpdir(), "joko-messaging-manager-"));
  const store = new OperationalStore(join(root, "operational.db"));
  const artifacts = new ArtifactStore({
    rootDirectory: join(root, "artifacts"),
    repository: new OperationalArtifactRepository(store),
    ingestRoots: [root]
  });
  await artifacts.initialize();
  const vault = await CredentialVault.open(join(root, "vault.key"));
  const credentials = new CredentialManager({
    vault,
    storagePath: join(root, "credentials.json")
  });
  await credentials.initialize();
  const adapter = adapterFactory?.() ?? new FakeBackendAdapter(PI_LIKE_PROFILE);
  let manager: MessagingManager | undefined;
  const host = new SessionHost(store, artifacts, [adapter], {
    onServiceRunSettled: (input) => manager?.onRunSettled(input),
    onServiceInteractionOpened: (input) => manager?.onInteractionOpened(input),
    onServiceInteractionSettled: (input) => manager?.onInteractionSettled(input)
  });
  await host.initialize();
  await host.registerTarget({
    id: "target-one",
    backendId: adapter.id,
    displayName: "Messaging target",
    workspaceRoot: root,
    managed: true,
    trusted: true
  });
  const options: MessagingManagerOptions = {
    store,
    credentials,
    sessionHost: host,
    artifacts,
    retryDelayMs: 5,
    pollTimeoutSeconds: 0,
    ...(transportFactory === undefined ? {} : {
      createTelegramTransport: (input) => transportFactory(input).bind(input)
    }),
    ...(discordTransportFactory === undefined ? {} : {
      createDiscordTransport: (input) => discordTransportFactory(input).bind(input)
    })
  };
  manager = new MessagingManager(options);
  await manager.initialize();
  cleanups.push(async () => {
    await manager?.close().catch(() => undefined);
    await host.dispose().catch(() => undefined);
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, store, artifacts, credentials, adapter, host, manager };
}

async function replaceCredential(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  connection: ReturnType<MessagingManager["getConnection"]>,
  suffix: string,
  enable = false
) {
  const ticket = fixture.manager.beginCredentialUpload({
    clientConnectionId: "desktop-one",
    messagingConnectionId: connection.id,
    expectedRevision: connection.revision,
    expectedGeneration: connection.generation
  });
  fixture.credentials.upload(ticket.credentialUploadTicketId, token(suffix), "desktop-one");
  return fixture.manager.commitCredential({
    credentialUploadTicketId: ticket.credentialUploadTicketId,
    clientConnectionId: "desktop-one",
    enable
  });
}

function token(suffix: string): string {
  return `123456:${suffix.padEnd(32, "x")}`;
}

function directMessageBatch(): TelegramNormalizationResult {
  return {
    events: [{
      kind: "message",
      providerRequestIds: ["telegram-update:9"],
      messageId: "77",
      address: {
        channel: "telegram",
        connectionId: "placeholder",
        providerConversationId: "42",
        providerThreadId: null,
        conversationKind: "direct"
      },
      speaker: {
        providerUserId: "42",
        displayName: "Owner",
        username: "owner",
        isBot: false,
        isOwner: true
      },
      occurredAt: Date.now(),
      text: "Hello from Telegram",
      ambient: false,
      protectedContent: false,
      attachments: [],
      unsupported: [],
      replyContext: null
    }],
    groupObservations: [],
    ignored: []
  };
}

function albumUpdate(updateId: number, messageId: number): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      from: { id: 42, is_bot: false, first_name: "Owner", username: "owner" },
      chat: { id: 42, type: "private", first_name: "Owner" },
      date: Math.floor(Date.now() / 1_000),
      media_group_id: "album-one"
    }
  };
}

function waitForAbort(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_resolve, reject) => {
    const fail = () => reject(new MessagingTransportError("cancelled", "test poll cancelled", {
      retryable: false,
      effect: "none"
    }));
    if (signal?.aborted) fail();
    else signal?.addEventListener("abort", fail, { once: true });
  });
}
