import { create } from "@bufbuild/protobuf";
import {
  MessagingChannel,
  MessagingConnectionRuntimeStatus,
  PermissionMode,
  TelegramEmojiReactions,
  TelegramMessagingConfigurationSchema,
  TelegramReplyQuoteMode
} from "@joko/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { waitFor } from "./fixture.js";
import {
  REAL_PI_MODEL_ID,
  REAL_PI_PROVIDER_ID,
  RealPiSystemFixture
} from "./real-pi-fixture.js";
import {
  TELEGRAM_SYSTEM_OWNER_ID,
  TELEGRAM_SYSTEM_TOKEN,
  TelegramSystemFixture
} from "./telegram-system-fixture.js";

const FIRST_REPLY = "TELEGRAM_E2_REPLY: the attached note reached the durable task.";
const SECOND_REPLY = "TELEGRAM_E2_RESTART_REPLY: the existing task resumed after restart.";

describe("Telegram Messaging production product chain", () => {
  let fixture: RealPiSystemFixture | undefined;
  let telegram: TelegramSystemFixture | undefined;

  afterEach(async () => {
    await fixture?.close({ removeRoot: true });
    fixture = undefined;
    await telegram?.close();
    telegram = undefined;
  });

  it("uses authenticated Connect, one-shot credentials, real HTTP, SQLite, attachments, and restart recovery", { timeout: 120_000 }, async () => {
    telegram = await TelegramSystemFixture.start();
    const attachmentBytes = new TextEncoder().encode("telegram attachment product-chain evidence\n");
    telegram.addFile({
      fileId: "telegram-note-1",
      path: "documents/product-chain-note.txt",
      bytes: attachmentBytes,
      mimeType: "text/plain"
    });

    fixture = await startSystem(telegram, ({ requestNumber }) => requestNumber === 1 ? FIRST_REPLY : SECOND_REPLY);
    const rootDirectory = fixture.rootDirectory;
    const paired = await fixture.pair("Telegram Messaging E2 owner");
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
      channel: MessagingChannel.TELEGRAM,
      ownerProviderUserId: String(TELEGRAM_SYSTEM_OWNER_ID),
      telegramConfiguration: create(TelegramMessagingConfigurationSchema, {
        emojiReactions: TelegramEmojiReactions.OFF,
        replyQuoteDm: TelegramReplyQuoteMode.FIRST,
        replyQuoteGroup: TelegramReplyQuoteMode.FIRST,
        groupActivationRules: []
      })
    })).connection, "created Telegram connection");
    const ticket = required((await paired.clients.messaging.beginMessagingCredentialUpload({
      connectionId: created.connectionId,
      expectedRevision: created.revision,
      expectedGeneration: created.generation
    })).ticket, "Telegram credential upload ticket");
    const upload = await fetch(new URL(ticket.relativeEndpoint, fixture.baseUrl), {
      method: "PUT",
      headers: {
        authorization: `Bearer ${paired.authKey}`,
        "content-type": "application/octet-stream"
      },
      body: Buffer.from(TELEGRAM_SYSTEM_TOKEN)
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
        && connection.providerAccountId === "700"
        && connection.credentialConfigured),
      "the production Telegram worker to connect",
      15_000
    );

    telegram.enqueueDirectMessage({
      updateId: 10,
      messageId: 100,
      text: "Inspect the attached product-chain note.",
      fileId: "telegram-note-1",
      fileName: "product-chain-note.txt",
      mimeType: "text/plain"
    });
    await waitFor(
      async () => telegram?.outboundMessages ?? [],
      (messages) => messages.some((message) => message.text === FIRST_REPLY),
      "the real Pi reply to leave through Telegram HTTP",
      60_000
    );

    const firstRequest = required(fixture.application.store.listMessagingInboundRequests()[0], "first Messaging request");
    expect(firstRequest).toMatchObject({
      status: "completed",
      providerRequestIds: ["telegram:update:10"],
      providerMessageId: "100",
      protectedContent: false
    });
    expect(firstRequest.artifactIds).toHaveLength(1);
    const staged = fixture.application.store.getArtifact(firstRequest.artifactIds[0]!);
    expect((await fixture.application.artifacts.readBlob(staged.blob)).data).toEqual(Buffer.from(attachmentBytes));
    const conversation = fixture.application.store.getMessagingConversation(firstRequest.conversationId!);
    expect(conversation.status).toBe("active");
    const sessionId = required(conversation.sessionId, "Telegram task Session");
    expect((await paired.clients.session.getSession({ sessionId })).session).toMatchObject({
      sessionId,
      targetId: "workspace-real-pi",
      backendId: "pi"
    });
    expect(fixture.providerRequests).toHaveLength(1);
    expect(telegram.methodCount("getFile")).toBe(1);

    const probesBeforeConflict = telegram.methodCount("getMe");
    telegram.failNextPollWithConflict();
    await waitFor(
      async () => fixture!.application.store.getMessagingConnection(created.connectionId),
      (connection) => connection.runtimeStatus === "conflict" && connection.errorCode === "polling_conflict",
      "the durable Telegram polling-conflict state",
      10_000
    );
    await waitFor(
      async () => fixture!.application.store.getMessagingConnection(created.connectionId),
      (connection) => connection.runtimeStatus === "connected"
        && telegram!.methodCount("getMe") > probesBeforeConflict,
      "the Telegram worker to recover after conflict",
      10_000
    );

    const firstCursor = fixture.application.store.getMessagingConnection(created.connectionId).cursor;
    expect(firstCursor).toBe("11");
    await fixture.close({ removeRoot: false });
    fixture = undefined;

    fixture = await startSystem(telegram, () => SECOND_REPLY, rootDirectory);
    const restartedClients = fixture.clients(authKey);
    await waitFor(
      async () => fixture!.application.store.getMessagingConnection(created.connectionId),
      (connection) => connection.runtimeStatus === "connected" && connection.cursor === firstCursor,
      "the persisted Telegram connection to reconnect after restart",
      15_000
    );
    telegram.enqueueDirectMessage({
      updateId: 11,
      messageId: 101,
      text: "Continue in the same visible task after restart."
    });
    await waitFor(
      async () => telegram?.outboundMessages ?? [],
      (messages) => messages.some((message) => message.text === SECOND_REPLY),
      "the restarted Telegram worker to deliver the second reply",
      60_000
    );

    const requests = fixture.application.store.listMessagingInboundRequests();
    expect(requests).toHaveLength(2);
    expect(requests.flatMap((request) => request.providerRequestIds).sort()).toEqual([
      "telegram:update:10",
      "telegram:update:11"
    ]);
    const restartedConversation = required(
      fixture.application.store.listMessagingConversations({ connectionId: created.connectionId })[0],
      "restarted Telegram conversation"
    );
    expect(restartedConversation.sessionId).toBe(sessionId);
    expect(fixture.application.store.getMessagingConnection(created.connectionId).cursor).toBe("12");
    expect((await restartedClients.session.getSession({ sessionId })).session?.sessionId).toBe(sessionId);
    expect(fixture.providerRequests).toHaveLength(1);

    const durableProjection = JSON.stringify({
      settings: fixture.application.store.listSettings(),
      connections: fixture.application.store.listMessagingConnections(),
      requests,
      deliveries: fixture.application.store.listMessagingDeliveries(),
      diagnostics: fixture.application.store.listDiagnostics({ limit: 200 })
    }, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value);
    expect(durableProjection).not.toContain(TELEGRAM_SYSTEM_TOKEN);
  });
});

async function startSystem(
  telegram: TelegramSystemFixture,
  reply: (input: { readonly requestNumber: number }) => string,
  rootDirectory?: string
): Promise<RealPiSystemFixture> {
  return RealPiSystemFixture.start({
    ...(rootDirectory === undefined ? {} : { rootDirectory }),
    keepRoot: rootDirectory === undefined,
    telegramApiBaseUrl: telegram.baseUrl,
    messagingRetryDelayMs: 250,
    providerResponder: ({ requestNumber }) => ({ kind: "text", text: reply({ requestNumber }) })
  });
}

function required<T>(value: T | null | undefined, label: string): T {
  if (value === undefined || value === null) throw new Error(`Missing ${label}.`);
  return value;
}
