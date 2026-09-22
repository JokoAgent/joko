import { create } from "@bufbuild/protobuf";
import {
  DiscordEmojiReactions,
  DiscordGroupActivation,
  DiscordMessagingConfigurationSchema,
  DiscordReplyQuoteMode,
  MessagingChannel,
  MessagingConnectionRuntimeStatus,
  PermissionMode
} from "@joko/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  DISCORD_SYSTEM_BOT_ID,
  DISCORD_SYSTEM_GUILD_ID,
  DISCORD_SYSTEM_OWNER_ID,
  DISCORD_SYSTEM_ROOT_CHANNEL_ID,
  DISCORD_SYSTEM_THREAD_ID,
  DISCORD_SYSTEM_TOKEN,
  DiscordSystemFixture
} from "./discord-system-fixture.js";
import { waitFor } from "./fixture.js";
import {
  REAL_PI_MODEL_ID,
  REAL_PI_PROVIDER_ID,
  RealPiSystemFixture
} from "./real-pi-fixture.js";

const FIRST_MESSAGE_ID = "900000000000000001";
const SECOND_MESSAGE_ID = "900000000000000002";
const ATTACHMENT_ID = "888888888888888888";
const FIRST_REPLY = "DISCORD_E2_REPLY: the thread attachment reached the durable task.";
const SECOND_REPLY = "DISCORD_E2_RESTART_REPLY: the existing thread task resumed after restart.";

describe("Discord Messaging production product chain", () => {
  let fixture: RealPiSystemFixture | undefined;
  let discord: DiscordSystemFixture | undefined;

  afterEach(async () => {
    await fixture?.close({ removeRoot: true });
    fixture = undefined;
    await discord?.close();
    discord = undefined;
  });

  it("uses authenticated Connect, direct REST + Gateway, an approved thread, attachments, resume, and restart recovery", { timeout: 120_000 }, async () => {
    discord = await DiscordSystemFixture.start();
    const attachmentBytes = new TextEncoder().encode("discord attachment product-chain evidence\n");
    discord.addAttachment({
      id: ATTACHMENT_ID,
      fileName: "discord-product-chain-note.txt",
      bytes: attachmentBytes,
      mimeType: "text/plain"
    });

    fixture = await startSystem(discord, ({ requestNumber }) => requestNumber === 1 ? FIRST_REPLY : SECOND_REPLY);
    const rootDirectory = fixture.rootDirectory;
    const paired = await fixture.pair("Discord Messaging E2 owner");
    const authKey = paired.authKey;

    await paired.clients.messaging.putMessagingRoute({
      targetId: "workspace-real-pi",
      providerId: REAL_PI_PROVIDER_ID,
      modelId: REAL_PI_MODEL_ID,
      effort: "off",
      fastMode: false,
      permissionMode: PermissionMode.ASK,
      planMode: false
    });
    const created = required((await paired.clients.messaging.createMessagingConnection({
      channel: MessagingChannel.DISCORD,
      ownerProviderUserId: DISCORD_SYSTEM_OWNER_ID,
      discordConfiguration: create(DiscordMessagingConfigurationSchema, {
        lifecycleAnnouncements: false,
        emojiReactions: DiscordEmojiReactions.OFF,
        replyQuoteDm: DiscordReplyQuoteMode.FIRST,
        replyQuoteGroup: DiscordReplyQuoteMode.FIRST,
        groupActivationRules: [{
          guildId: DISCORD_SYSTEM_GUILD_ID,
          channelId: DISCORD_SYSTEM_ROOT_CHANNEL_ID,
          activation: DiscordGroupActivation.ALWAYS
        }]
      })
    })).connection, "created Discord connection");
    const ticket = required((await paired.clients.messaging.beginMessagingCredentialUpload({
      connectionId: created.connectionId,
      expectedRevision: created.revision,
      expectedGeneration: created.generation
    })).ticket, "Discord credential upload ticket");
    const upload = await fetch(new URL(ticket.relativeEndpoint, fixture.baseUrl), {
      method: "PUT",
      headers: {
        authorization: `Bearer ${authKey}`,
        "content-type": "application/octet-stream"
      },
      body: Buffer.from(DISCORD_SYSTEM_TOKEN)
    });
    expect(upload.status).toBe(204);
    await paired.clients.messaging.commitMessagingCredential({
      credentialUploadTicketId: ticket.ticketId,
      enable: true
    });

    await waitFor(
      () => paired.clients.messaging.getMessagingSettings({}),
      (settings) => settings.connections.some((connection) =>
        connection.connectionId === created.connectionId
        && connection.runtimeStatus === MessagingConnectionRuntimeStatus.CONNECTED
        && connection.providerAccountId === DISCORD_SYSTEM_BOT_ID
        && connection.credentialConfigured),
      "the production Discord worker to connect",
      15_000
    );

    discord.enqueueThreadMessage({
      messageId: FIRST_MESSAGE_ID,
      text: "Inspect the attached note in this approved thread.",
      attachmentId: ATTACHMENT_ID
    });
    await waitFor(
      async () => discord?.outboundMessages ?? [],
      (messages) => messages.some((message) => message.text === FIRST_REPLY),
      "the real Pi reply to leave through Discord REST",
      60_000
    );

    const firstRequest = required(fixture.application.store.listMessagingInboundRequests()[0], "first Discord request");
    expect(firstRequest).toMatchObject({
      status: "completed",
      providerRequestIds: [`discord:message:${FIRST_MESSAGE_ID}`],
      providerMessageId: FIRST_MESSAGE_ID,
      protectedContent: false
    });
    expect(firstRequest.artifactIds).toHaveLength(1);
    const staged = fixture.application.store.getArtifact(firstRequest.artifactIds[0]!);
    expect((await fixture.application.artifacts.readBlob(staged.blob)).data).toEqual(Buffer.from(attachmentBytes));
    const conversation = fixture.application.store.getMessagingConversation(firstRequest.conversationId!);
    expect(conversation).toMatchObject({
      status: "active",
      providerConversationId: DISCORD_SYSTEM_ROOT_CHANNEL_ID,
      providerThreadId: DISCORD_SYSTEM_THREAD_ID
    });
    const sessionId = required(conversation.sessionId, "Discord task Session");
    expect((await paired.clients.session.getSession({ sessionId })).session).toMatchObject({
      sessionId,
      targetId: "workspace-real-pi",
      backendId: "pi"
    });
    expect(fixture.providerRequests).toHaveLength(1);
    expect(discord.outboundMessages).toContainEqual(expect.objectContaining({
      channelId: DISCORD_SYSTEM_THREAD_ID,
      text: FIRST_REPLY,
      replyToMessageId: FIRST_MESSAGE_ID
    }));

    const cursorBeforeReconnect = fixture.application.store.getMessagingConnection(created.connectionId).cursor;
    const resumesBeforeReconnect = discord.resumeSequences.length;
    discord.forceGatewayReconnect();
    await waitFor(
      async () => discord?.resumeSequences ?? [],
      (sequences) => sequences.length > resumesBeforeReconnect,
      "the live Discord Gateway to resume after disconnect",
      10_000
    );
    expect(discord.resumeSequences.at(-1)).toBe(cursorSequence(cursorBeforeReconnect));
    await waitFor(
      async () => fixture!.application.store.getMessagingConnection(created.connectionId).cursor,
      (cursor) => cursor !== cursorBeforeReconnect,
      "the resumed Discord cursor to persist",
      10_000
    );

    const persistedCursor = fixture.application.store.getMessagingConnection(created.connectionId).cursor;
    const resumesBeforeRestart = discord.resumeSequences.length;
    await fixture.close({ removeRoot: false });
    fixture = undefined;

    fixture = await startSystem(discord, () => SECOND_REPLY, rootDirectory);
    const restartedClients = fixture.clients(authKey);
    await waitFor(
      async () => discord?.resumeSequences ?? [],
      (sequences) => sequences.length > resumesBeforeRestart,
      "the persisted Discord Gateway session to resume after restart",
      15_000
    );
    expect(discord.resumeSequences.at(-1)).toBe(cursorSequence(persistedCursor));
    await waitFor(
      async () => fixture!.application.store.getMessagingConnection(created.connectionId),
      (connection) => connection.runtimeStatus === "connected",
      "the persisted Discord connection to reconnect after restart",
      15_000
    );

    discord.enqueueThreadMessage({
      messageId: SECOND_MESSAGE_ID,
      text: "Continue in the same visible thread task after restart."
    });
    await waitFor(
      async () => discord?.outboundMessages ?? [],
      (messages) => messages.some((message) => message.text === SECOND_REPLY),
      "the restarted Discord worker to deliver the second reply",
      60_000
    );

    const requests = fixture.application.store.listMessagingInboundRequests();
    expect(requests).toHaveLength(2);
    expect(requests.flatMap((request) => request.providerRequestIds).sort()).toEqual([
      `discord:message:${FIRST_MESSAGE_ID}`,
      `discord:message:${SECOND_MESSAGE_ID}`
    ]);
    const restartedConversation = required(
      fixture.application.store.listMessagingConversations({ connectionId: created.connectionId })[0],
      "restarted Discord conversation"
    );
    expect(restartedConversation.sessionId).toBe(sessionId);
    expect((await restartedClients.session.getSession({ sessionId })).session?.sessionId).toBe(sessionId);
    expect(fixture.providerRequests).toHaveLength(1);
    expect(discord.outboundMessages).toContainEqual(expect.objectContaining({
      channelId: DISCORD_SYSTEM_THREAD_ID,
      text: SECOND_REPLY,
      replyToMessageId: SECOND_MESSAGE_ID
    }));

    const durableProjection = JSON.stringify({
      settings: fixture.application.store.listSettings(),
      connections: fixture.application.store.listMessagingConnections(),
      requests,
      deliveries: fixture.application.store.listMessagingDeliveries(),
      diagnostics: fixture.application.store.listDiagnostics({ limit: 200 })
    }, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value);
    expect(durableProjection).not.toContain(DISCORD_SYSTEM_TOKEN);
  });
});

async function startSystem(
  discord: DiscordSystemFixture,
  reply: (input: { readonly requestNumber: number }) => string,
  rootDirectory?: string
): Promise<RealPiSystemFixture> {
  return RealPiSystemFixture.start({
    ...(rootDirectory === undefined ? {} : { rootDirectory }),
    keepRoot: rootDirectory === undefined,
    discordApiBaseUrl: discord.apiBaseUrl,
    messagingPollTimeoutSeconds: 1,
    messagingRetryDelayMs: 250,
    providerResponder: ({ requestNumber }) => ({ kind: "text", text: reply({ requestNumber }) })
  });
}

function cursorSequence(value: string | null | undefined): number {
  if (value === null || value === undefined) throw new Error("Missing Discord cursor.");
  const parsed = JSON.parse(value) as { readonly sequence?: unknown };
  if (!Number.isSafeInteger(parsed.sequence)) throw new Error("Invalid Discord cursor sequence.");
  return parsed.sequence as number;
}

function required<T>(value: T | null | undefined, label: string): T {
  if (value === undefined || value === null) throw new Error(`Missing ${label}.`);
  return value;
}
