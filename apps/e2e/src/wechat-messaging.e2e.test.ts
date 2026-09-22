import { create } from "@bufbuild/protobuf";
import {
  MessagingChannel,
  MessagingConnectionRuntimeStatus,
  PermissionMode,
  WeChatAuthorizationStatus,
  WeChatMessagingConfigurationSchema
} from "@joko/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { waitFor } from "./fixture.js";
import { REAL_PI_MODEL_ID, REAL_PI_PROVIDER_ID, RealPiSystemFixture } from "./real-pi-fixture.js";
import {
  WECHAT_SYSTEM_BOT_ID,
  WECHAT_SYSTEM_CONTEXT,
  WECHAT_SYSTEM_PEER_ID,
  WECHAT_SYSTEM_TOKEN,
  WeChatSystemFixture
} from "./wechat-system-fixture.js";

const FIRST_REPLY = "WECHAT_E2_REPLY: real Pi reached the direct task.";
const SECOND_REPLY = "WECHAT_E2_RESTART_REPLY: the same direct task recovered.";

describe("WeChat Messaging production product chain", () => {
  let fixture: RealPiSystemFixture | undefined;
  let wechat: WeChatSystemFixture | undefined;

  afterEach(async () => {
    await fixture?.close({ removeRoot: true });
    await wechat?.close();
    fixture = undefined;
    wechat = undefined;
  });

  it("uses Connect QR authorization, durable direct peer admission, real Pi, protected reply context and restart cursor", { timeout: 120_000 }, async () => {
    wechat = await WeChatSystemFixture.start();
    fixture = await startSystem(wechat, FIRST_REPLY);
    const rootDirectory = fixture.rootDirectory;
    const paired = await fixture.pair("WeChat Messaging E2 owner");
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
      channel: MessagingChannel.WECHAT,
      wechatConfiguration: create(WeChatMessagingConfigurationSchema)
    })).connection, "WeChat connection");
    const started = required((await paired.clients.messaging.beginWeChatAuthorization({
      connectionId: created.connectionId,
      expectedRevision: created.revision,
      expectedGeneration: created.generation
    })).attempt, "WeChat QR attempt");
    expect(started.status).toBe(WeChatAuthorizationStatus.WAITING);
    expect(started.qrCodeUrl).toMatch(/^https:\/\/weixin\.qq\.com\//u);
    const confirmed = required((await paired.clients.messaging.getWeChatAuthorization({
      connectionId: created.connectionId,
      attemptId: started.attemptId,
      expectedGeneration: created.generation
    })).attempt, "confirmed WeChat authorization");
    expect(confirmed.status).toBe(WeChatAuthorizationStatus.SUCCEEDED);
    expect(confirmed.connection?.credentialConfigured).toBe(true);
    expect(JSON.stringify(confirmed, bigintJson)).not.toContain(WECHAT_SYSTEM_TOKEN);
    await waitFor(
      () => paired.clients.messaging.getMessagingSettings({}),
      (settings) => settings.connections.some((connection) =>
        connection.connectionId === created.connectionId
        && connection.runtimeStatus === MessagingConnectionRuntimeStatus.CONNECTED
        && connection.providerAccountId === WECHAT_SYSTEM_BOT_ID),
      "the production WeChat transport to connect", 15_000
    );

    wechat.enqueueDirectText("wechat-first", "Handle the first WeChat direct message.");
    await waitFor(
      async () => wechat?.outbound ?? [],
      (messages) => messages.some((message) => outboundText(message) === FIRST_REPLY),
      "the first real Pi response to leave through iLink HTTP", 45_000
    );
    const firstRequest = required(
      fixture.application.store.listMessagingInboundRequests().find((request) =>
        request.providerMessageId === "client:wechat-first"),
      "first WeChat inbound request"
    );
    expect(firstRequest.status).toBe("completed");
    const conversation = fixture.application.store.getMessagingConversation(firstRequest.conversationId!);
    expect(conversation).toMatchObject({
      status: "active", providerConversationId: WECHAT_SYSTEM_PEER_ID, conversationKind: "direct"
    });
    const sessionId = required(conversation.sessionId, "visible WeChat task");
    expect((await paired.clients.session.getSession({ sessionId })).session).toMatchObject({
      sessionId, targetId: "workspace-real-pi", backendId: "pi"
    });
    const firstOutbound = required(wechat.outbound.find((message) => outboundText(message) === FIRST_REPLY), "first iLink reply");
    expect(firstOutbound["context_token"]).toBe(WECHAT_SYSTEM_CONTEXT);
    expect(firstOutbound["client_id"]).toBe(
      fixture.application.store.listMessagingDeliveries({ connectionId: created.connectionId })
        .find((delivery) => delivery.kind === "text")?.id
    );

    const imageBytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64"
    );
    wechat.enqueueDirectImage("wechat-image", "Inspect this image in the same task.", imageBytes);
    const imageRequest = await waitFor(
      async () => fixture!.application.store.listMessagingInboundRequests()
        .find((request) => request.providerMessageId === "client:wechat-image"),
      (request) => request?.status === "completed" && request.artifactIds.length === 1,
      "the encrypted WeChat image to become a task Artifact", 45_000
    );
    const imageArtifact = fixture.application.store.getArtifact(imageRequest!.artifactIds[0]!);
    expect(Buffer.from((await fixture.application.artifacts.readBlob(imageArtifact.blob)).data)).toEqual(imageBytes);
    expect(fixture.application.store.getMessagingConversation(imageRequest!.conversationId!).sessionId).toBe(sessionId);

    const cursor = required(fixture.application.store.getMessagingConnection(created.connectionId).cursor, "durable WeChat cursor");
    await fixture.close({ removeRoot: false });
    fixture = undefined;
    fixture = await startSystem(wechat, SECOND_REPLY, rootDirectory);
    const restartedClients = fixture.clients(authKey);
    expect(fixture.application.store.getMessagingConnection(created.connectionId).cursor).toBe(cursor);
    await waitFor(
      async () => fixture!.application.store.getMessagingConnection(created.connectionId),
      (connection) => connection.runtimeStatus === "connected",
      "the restored WeChat worker", 15_000
    );
    wechat.enqueueDirectText("wechat-second", "Continue the WeChat task after restart.");
    await waitFor(
      async () => wechat?.outbound ?? [],
      (messages) => messages.some((message) => outboundText(message) === SECOND_REPLY),
      "the restarted WeChat reply", 45_000
    );
    const restartedConversation = fixture.application.store.getMessagingConversation(conversation.id);
    expect(restartedConversation.sessionId).toBe(sessionId);
    expect((await restartedClients.session.getSession({ sessionId })).session?.sessionId).toBe(sessionId);
    expect(wechat.requestedCursors).toContain(cursor);
    const projection = JSON.stringify({
      connections: fixture.application.store.listMessagingConnections(),
      requests: fixture.application.store.listMessagingInboundRequests(),
      deliveries: fixture.application.store.listMessagingDeliveries(),
      diagnostics: fixture.application.store.listDiagnostics({ limit: 100 })
    }, bigintJson);
    expect(projection).not.toContain(WECHAT_SYSTEM_TOKEN);
    expect(projection).not.toContain(WECHAT_SYSTEM_CONTEXT);
  });
});

function startSystem(wechat: WeChatSystemFixture, reply: string, rootDirectory?: string): Promise<RealPiSystemFixture> {
  return RealPiSystemFixture.start({
    ...(rootDirectory === undefined ? {} : { rootDirectory }),
    keepRoot: rootDirectory === undefined,
    createWeChatAuthorization: wechat.createAuthorization,
    createWeChatTransport: wechat.createTransport,
    providerSupportsImages: true,
    messagingPollTimeoutSeconds: 1,
    messagingRetryDelayMs: 1_000,
    providerResponder: () => ({ kind: "text", text: reply })
  });
}

function outboundText(message: Readonly<Record<string, unknown>>): string | undefined {
  const items = message["item_list"];
  if (!Array.isArray(items)) return undefined;
  const first: unknown = items[0];
  if (!isRecord(first) || !isRecord(first["text_item"])) return undefined;
  const text = first["text_item"]["text"];
  return typeof text === "string" ? text : undefined;
}

function required<T>(value: T | null | undefined | "", label: string): T {
  if (value === undefined || value === null || value === "") throw new Error(`Missing ${label}.`);
  return value;
}

function bigintJson(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
