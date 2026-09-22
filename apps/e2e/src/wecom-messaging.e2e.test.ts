import { create } from "@bufbuild/protobuf";
import {
  MessagingChannel,
  MessagingConnectionRuntimeStatus,
  PermissionMode,
  WeComMessagingConfigurationSchema
} from "@joko/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { waitFor } from "./fixture.js";
import {
  REAL_PI_MODEL_ID,
  REAL_PI_PROVIDER_ID,
  type CapturedProviderRequest,
  RealPiSystemFixture
} from "./real-pi-fixture.js";
import {
  WECOM_SYSTEM_BOT_ID,
  WECOM_SYSTEM_BOT_SECRET,
  WECOM_SYSTEM_GROUP_ID,
  WECOM_SYSTEM_OWNER_ID,
  WECOM_SYSTEM_PRIVATE_AES_KEY,
  WECOM_SYSTEM_PRIVATE_FRAME,
  WECOM_SYSTEM_PRIVATE_URL,
  WeComSystemFixture
} from "./wecom-system-fixture.js";

const DIRECT_CALLBACK_ID = "wecom-callback-direct";
const PERMISSION_CALLBACK_ID = "wecom-callback-permission";
const GROUP_CALLBACK_ID = "wecom-callback-group";
const OTHER_GROUP_CALLBACK_ID = "wecom-callback-other-group";
const RESTART_CALLBACK_ID = "wecom-callback-restart";
const DIRECT_MESSAGE_ID = "wecom-message-direct";
const PERMISSION_MESSAGE_ID = "wecom-message-permission";
const GROUP_MESSAGE_ID = "wecom-message-group";
const OTHER_GROUP_MESSAGE_ID = "wecom-message-other-group";
const RESTART_MESSAGE_ID = "wecom-message-restart";
const LONG_REPLY = `WECOM_E2_LONG_REPLY:${"界".repeat(7_000)}`;
const GROUP_REPLY = "WECOM_E2_GROUP_REPLY: the owner group reached its routed task.";
const RESTART_REPLY = "WECOM_E2_RESTART_REPLY: the claimed direct task resumed after restart.";
const VOICE_TRANSCRIPT = "Recognized WeCom voice asks for the release summary.";
const PROVIDER_KEYS = ["wecom-image-key", "wecom-file-key", "wecom-video-key"] as const;

describe("WeCom Messaging production product chain", () => {
  let fixture: RealPiSystemFixture | undefined;
  let wecom: WeComSystemFixture | undefined;

  afterEach(async () => {
    await fixture?.close({ removeRoot: true });
    fixture = undefined;
    wecom = undefined;
  });

  it("uses authenticated Connect, media, callback reply, text permission, chunking, reconnect, and restart recovery", { timeout: 150_000 }, async () => {
    wecom = new WeComSystemFixture();
    const imageBytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64"
    );
    const attachmentBytes = [
      imageBytes,
      Buffer.from("WeCom file product-chain evidence\n"),
      Buffer.from("WeCom video product-chain evidence\n")
    ] as const;
    wecom.addAttachment({
      providerKey: PROVIDER_KEYS[0], mediaKind: "image", fileName: "wecom-image.png",
      mimeType: "image/png", bytes: attachmentBytes[0]
    });
    wecom.addAttachment({
      providerKey: PROVIDER_KEYS[1], mediaKind: "file", fileName: "wecom-note.txt",
      mimeType: "text/plain", bytes: attachmentBytes[1]
    });
    wecom.addAttachment({
      providerKey: PROVIDER_KEYS[2], mediaKind: "video", fileName: "wecom-video.bin",
      mimeType: "application/octet-stream", bytes: attachmentBytes[2]
    });
    fixture = await startSystem(wecom, providerReply);
    const rootDirectory = fixture.rootDirectory;
    const paired = await fixture.pair("WeCom Messaging E2 owner");
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
      channel: MessagingChannel.WECOM,
      wecomConfiguration: create(WeComMessagingConfigurationSchema, { botId: WECOM_SYSTEM_BOT_ID })
    })).connection, "created WeCom connection");
    expect(created.ownerProviderUserId).toBeUndefined();
    const ticket = required((await paired.clients.messaging.beginMessagingCredentialUpload({
      connectionId: created.connectionId,
      expectedRevision: created.revision,
      expectedGeneration: created.generation
    })).ticket, "WeCom credential upload ticket");
    const upload = await fetch(new URL(ticket.relativeEndpoint, fixture.baseUrl), {
      method: "PUT",
      headers: {
        authorization: `Bearer ${authKey}`,
        "content-type": "application/octet-stream"
      },
      body: Buffer.from(WECOM_SYSTEM_BOT_SECRET)
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
        && connection.providerAccountId === WECOM_SYSTEM_BOT_ID
        && connection.ownerProviderUserId === undefined
        && connection.credentialConfigured),
      "the production WeCom worker to connect",
      15_000
    );

    wecom.enqueueDirectMedia({
      callbackMessageId: DIRECT_CALLBACK_ID,
      messageId: DIRECT_MESSAGE_ID,
      text: "Inspect the WeCom image, file, video, and voice payloads.",
      providerKeys: PROVIDER_KEYS,
      voiceTranscript: VOICE_TRANSCRIPT
    });
    await waitFor(
      async () => ({ beginReplies: wecom?.beginReplies ?? [], cards: wecom?.interactionCards ?? [] }),
      (value) => value.beginReplies.includes(DIRECT_MESSAGE_ID) && value.cards.length === 1,
      "the WeCom callback beginReply and permission text interaction",
      30_000
    );
    expect(wecom.effects.indexOf(`begin:${DIRECT_MESSAGE_ID}`)).toBeLessThan(
      wecom.effects.findIndex((effect) => effect.startsWith("interaction:"))
    );
    expect(wecom.effects.indexOf(`begin:${DIRECT_MESSAGE_ID}`)).toBeLessThan(
      wecom.effects.findIndex((effect) => effect.startsWith("download:"))
    );
    expect(wecom.interactionCards[0]?.buttons.length).toBeGreaterThan(0);

    wecom.enqueueDirectText({
      callbackMessageId: PERMISSION_CALLBACK_ID,
      messageId: PERMISSION_MESSAGE_ID,
      text: "1"
    });
    await waitFor(
      async () => wecom?.outboundTexts ?? [],
      (messages) => reconstructReply(messages.map((message) => message.text), LONG_REPLY) === LONG_REPLY,
      "the permitted real Pi response to leave through 18 KiB WeCom chunks",
      60_000
    );
    const longParts = replyParts(wecom.outboundTexts.map((message) => message.text), LONG_REPLY);
    expect(longParts.join("")).toBe(LONG_REPLY);
    expect(longParts).toHaveLength(2);
    expect(longParts.every((part) => Buffer.byteLength(part, "utf8") <= 18 * 1024)).toBe(true);
    const longMessages = wecom.outboundTexts.filter((message) => longParts.includes(message.text));
    expect(longMessages.map((message) => message.callbackMessageId)).toEqual([DIRECT_MESSAGE_ID, undefined]);
    const firstLongEffect = wecom.effects.findIndex((effect) => {
      if (!effect.startsWith("text:")) return false;
      const id = effect.slice("text:".length);
      return wecom?.outboundTexts.find((message) => message.providerMessageId === id)?.text.startsWith("WECOM_E2_LONG_REPLY:") === true;
    });
    expect(wecom.effects.indexOf(`begin:${DIRECT_MESSAGE_ID}`)).toBeLessThan(firstLongEffect);

    const claimed = fixture.application.store.getMessagingConnection(created.connectionId);
    expect(claimed.ownerProviderUserId).toBe(WECOM_SYSTEM_OWNER_ID);
    const directRequest = required(
      fixture.application.store.listMessagingInboundRequests().find((request) =>
        request.providerRequestIds.includes(`wecom:callback:${DIRECT_CALLBACK_ID}`)),
      "first WeCom request"
    );
    expect(directRequest).toMatchObject({
      status: "completed",
      providerMessageId: DIRECT_MESSAGE_ID,
      protectedContent: false
    });
    expect(directRequest.artifactIds).toHaveLength(3);
    const stagedBytes = await Promise.all(directRequest.artifactIds.map(async (artifactId) => {
      const artifact = fixture!.application.store.getArtifact(artifactId);
      return Buffer.from((await fixture!.application.artifacts.readBlob(artifact.blob)).data);
    }));
    expect(stagedBytes).toEqual(attachmentBytes.map((bytes) => Buffer.from(bytes)));
    expect(JSON.stringify(fixture.providerRequests[0]?.body ?? {})).toContain(VOICE_TRANSCRIPT);
    const directConversation = fixture.application.store.getMessagingConversation(directRequest.conversationId!);
    expect(directConversation).toMatchObject({
      status: "active",
      providerConversationId: WECOM_SYSTEM_OWNER_ID,
      providerThreadId: ""
    });
    const directSessionId = required(directConversation.sessionId, "WeCom direct task Session");
    expect((await paired.clients.session.getSession({ sessionId: directSessionId })).session).toMatchObject({
      sessionId: directSessionId,
      targetId: "workspace-real-pi",
      backendId: "pi"
    });

    wecom.enqueueOwnerGroupText({
      callbackMessageId: GROUP_CALLBACK_ID,
      messageId: GROUP_MESSAGE_ID,
      text: "Handle this owner-authored WeCom group message."
    });
    await waitFor(
      async () => wecom?.outboundTexts ?? [],
      (messages) => messages.some((message) => message.text === GROUP_REPLY),
      "the owner WeCom group reply",
      60_000
    );
    const groupConversation = required(
      fixture.application.store.listMessagingConversations({ connectionId: created.connectionId })
        .find((conversation) => conversation.providerConversationId === WECOM_SYSTEM_GROUP_ID),
      "owner WeCom group conversation"
    );
    expect(groupConversation).toMatchObject({ status: "active", providerThreadId: "" });

    const providerRequestsBeforeOther = fixture.providerRequests.length;
    wecom.enqueueOtherGroupText({
      callbackMessageId: OTHER_GROUP_CALLBACK_ID,
      messageId: OTHER_GROUP_MESSAGE_ID,
      text: "This non-owner message must not enter the durable task."
    });
    await waitFor(
      async () => fixture!.application.store.getMessagingConnection(created.connectionId).cursor,
      (cursor) => cursor === `wecom:callback:${OTHER_GROUP_CALLBACK_ID}`,
      "the unauthorized WeCom group callback to advance only the provider cursor",
      15_000
    );
    expect(fixture.providerRequests).toHaveLength(providerRequestsBeforeOther);
    expect(fixture.application.store.listMessagingInboundRequests().some((request) =>
      request.providerMessageId === OTHER_GROUP_MESSAGE_ID)).toBe(false);

    const cursorBeforeDisconnect = claimedCursor(fixture, created.connectionId);
    const transportsBeforeDisconnect = wecom.transportStarts;
    wecom.forceRetryableDisconnect();
    await waitFor(
      async () => fixture!.application.store.getMessagingConnection(created.connectionId),
      (connection) => connection.runtimeStatus === "offline" && connection.errorCode === "network",
      "the retryable WeCom network failure to project offline",
      15_000
    );
    await waitFor(
      async () => wecom?.transportStarts ?? 0,
      (count) => count > transportsBeforeDisconnect,
      "the WeCom worker to rebuild after a retryable disconnect",
      15_000
    );
    await waitFor(
      async () => fixture!.application.store.getMessagingConnection(created.connectionId),
      (connection) => connection.runtimeStatus === "connected",
      "the reconnected WeCom runtime projection",
      15_000
    );
    expect(claimedCursor(fixture, created.connectionId)).toBe(cursorBeforeDisconnect);

    const persistedCursor = claimedCursor(fixture, created.connectionId);
    await fixture.close({ removeRoot: false });
    fixture = undefined;

    fixture = await startSystem(wecom, () => ({ kind: "text", text: RESTART_REPLY }), rootDirectory);
    const restartedClients = fixture.clients(authKey);
    expect(claimedCursor(fixture, created.connectionId)).toBe(persistedCursor);
    expect(fixture.application.store.getMessagingConnection(created.connectionId).ownerProviderUserId)
      .toBe(WECOM_SYSTEM_OWNER_ID);
    await waitFor(
      async () => fixture!.application.store.getMessagingConnection(created.connectionId),
      (connection) => connection.runtimeStatus === "connected",
      "the persisted WeCom connection to reconnect after restart",
      15_000
    );

    wecom.enqueueDirectText({
      callbackMessageId: RESTART_CALLBACK_ID,
      messageId: RESTART_MESSAGE_ID,
      text: "Continue in the same claimed WeCom direct task after restart."
    });
    await waitFor(
      async () => wecom?.outboundTexts ?? [],
      (messages) => messages.some((message) => message.text === RESTART_REPLY),
      "the restarted WeCom worker to deliver the direct reply",
      60_000
    );
    const restartedDirect = required(
      fixture.application.store.listMessagingConversations({ connectionId: created.connectionId })
        .find((conversation) => conversation.providerConversationId === WECOM_SYSTEM_OWNER_ID),
      "restarted WeCom direct conversation"
    );
    expect(restartedDirect.sessionId).toBe(directSessionId);
    expect((await restartedClients.session.getSession({ sessionId: directSessionId })).session?.sessionId)
      .toBe(directSessionId);
    expect(fixture.providerRequests).toHaveLength(1);

    const requests = fixture.application.store.listMessagingInboundRequests();
    expect(requests).toHaveLength(3);
    expect(requests.flatMap((request) => request.providerRequestIds).sort()).toEqual([
      `wecom:callback:${DIRECT_CALLBACK_ID}`,
      `wecom:callback:${GROUP_CALLBACK_ID}`,
      `wecom:callback:${RESTART_CALLBACK_ID}`
    ]);
    const durableProjection = JSON.stringify({
      settings: fixture.application.store.listSettings(),
      connections: fixture.application.store.listMessagingConnections(),
      requests,
      deliveries: fixture.application.store.listMessagingDeliveries(),
      diagnostics: fixture.application.store.listDiagnostics({ limit: 200 })
    }, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value);
    for (const privateValue of [
      WECOM_SYSTEM_BOT_SECRET,
      WECOM_SYSTEM_PRIVATE_FRAME,
      WECOM_SYSTEM_PRIVATE_URL,
      WECOM_SYSTEM_PRIVATE_AES_KEY,
      ...PROVIDER_KEYS
    ]) {
      expect(durableProjection).not.toContain(privateValue);
    }
  });
});

async function startSystem(
  wecom: WeComSystemFixture,
  responder: (input: { readonly request: CapturedProviderRequest; readonly requestNumber: number }) =>
    | { readonly kind: "text"; readonly text: string }
    | { readonly kind: "tool"; readonly name: string; readonly arguments: Readonly<Record<string, unknown>>; readonly callId?: string },
  rootDirectory?: string
): Promise<RealPiSystemFixture> {
  return RealPiSystemFixture.start({
    ...(rootDirectory === undefined ? {} : { rootDirectory }),
    keepRoot: rootDirectory === undefined,
    createWeComTransport: wecom.createTransport,
    providerSupportsImages: true,
    messagingPollTimeoutSeconds: 1,
    messagingRetryDelayMs: 1_000,
    providerResponder: responder
  });
}

function providerReply(input: { readonly request: CapturedProviderRequest; readonly requestNumber: number }) {
  if (lastMessageRole(input.request) === "tool") return { kind: "text" as const, text: LONG_REPLY };
  const userText = latestUserText(input.request);
  if (userText.includes("owner-authored WeCom group")) return { kind: "text" as const, text: GROUP_REPLY };
  return {
    kind: "tool" as const,
    name: requiredToolName(input.request, "bash"),
    arguments: { command: "echo wecom-permission-product-chain" },
    callId: `wecom-permission-${input.requestNumber}`
  };
}

function requiredToolName(request: CapturedProviderRequest, suffix: string): string {
  const result = providerToolNames(request).find((name) => name === suffix || name.endsWith(`__${suffix}`));
  if (result === undefined) throw new Error(`Provider request did not advertise ${suffix}.`);
  return result;
}

function providerToolNames(request: CapturedProviderRequest): readonly string[] {
  const tools = Array.isArray(request.body["tools"]) ? request.body["tools"] : [];
  return tools.flatMap((tool) => {
    if (!isRecord(tool) || !isRecord(tool["function"])) return [];
    const name = tool["function"]["name"];
    return typeof name === "string" ? [name] : [];
  });
}

function lastMessageRole(request: CapturedProviderRequest): string | undefined {
  const messages = Array.isArray(request.body["messages"]) ? request.body["messages"] : [];
  const last = messages.at(-1);
  return isRecord(last) && typeof last["role"] === "string" ? last["role"] : undefined;
}

function latestUserText(request: CapturedProviderRequest): string {
  const messages = Array.isArray(request.body["messages"]) ? request.body["messages"] : [];
  for (const message of [...messages].reverse()) {
    if (!isRecord(message) || message["role"] !== "user") continue;
    const content = message["content"];
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content.flatMap((part) => isRecord(part) && typeof part["text"] === "string" ? [part["text"]] : []).join("\n");
  }
  return "";
}

function replyParts(messages: readonly string[], expected: string): readonly string[] {
  const start = messages.findIndex((message) => expected.startsWith(message) && message.startsWith("WECOM_E2_LONG_REPLY:"));
  if (start < 0) return [];
  const parts: string[] = [];
  let combined = "";
  for (const message of messages.slice(start)) {
    if (!expected.startsWith(combined + message)) break;
    parts.push(message);
    combined += message;
    if (combined === expected) break;
  }
  return parts;
}

function reconstructReply(messages: readonly string[], expected: string): string {
  return replyParts(messages, expected).join("");
}

function claimedCursor(fixture: RealPiSystemFixture, connectionId: string): string {
  const cursor = fixture.application.store.getMessagingConnection(connectionId).cursor;
  if (cursor === null || cursor === undefined) throw new Error("Missing WeCom cursor.");
  return cursor;
}

function required<T>(value: T | null | undefined | "", label: string): T {
  if (value === undefined || value === null || value === "") throw new Error(`Missing ${label}.`);
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
