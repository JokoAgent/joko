import { create } from "@bufbuild/protobuf";
import {
  DingTalkGroupActivation,
  DingTalkMessagingConfigurationSchema,
  MessagingChannel,
  MessagingConnectionRuntimeStatus,
  PermissionMode
} from "@joko/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  DINGTALK_SYSTEM_APP_KEY,
  DINGTALK_SYSTEM_APP_SECRET,
  DINGTALK_SYSTEM_GROUP_ID,
  DINGTALK_SYSTEM_OWNER_ID,
  DINGTALK_SYSTEM_SESSION_CAPABILITY,
  DingTalkSystemFixture
} from "./dingtalk-system-fixture.js";
import { waitFor } from "./fixture.js";
import {
  REAL_PI_MODEL_ID,
  REAL_PI_PROVIDER_ID,
  RealPiSystemFixture
} from "./real-pi-fixture.js";

const ATTACHMENT_CODE = "ding-private-download-code";
const FIRST_CALLBACK_ID = "ding-callback-1";
const GROUP_CALLBACK_ID = "ding-callback-2";
const RESTART_CALLBACK_ID = "ding-callback-3";
const FIRST_MESSAGE_ID = "ding-message-1";
const GROUP_MESSAGE_ID = "ding-message-2";
const RESTART_MESSAGE_ID = "ding-message-3";
const FIRST_REPLY = "DINGTALK_E2_REPLY: the direct attachment reached the durable task.";
const GROUP_REPLY = "DINGTALK_E2_GROUP_REPLY: the approved group reached its routed task.";
const RESTART_REPLY = "DINGTALK_E2_RESTART_REPLY: the claimed direct task resumed after restart.";

describe("DingTalk Messaging production product chain", () => {
  let fixture: RealPiSystemFixture | undefined;
  let dingtalk: DingTalkSystemFixture | undefined;

  afterEach(async () => {
    await fixture?.close({ removeRoot: true });
    fixture = undefined;
    await dingtalk?.close();
    dingtalk = undefined;
  });

  it("uses authenticated Connect, direct Stream, first-DM ownership, approved groups, attachments, reconnect, and restart recovery", { timeout: 120_000 }, async () => {
    dingtalk = await DingTalkSystemFixture.start();
    const attachmentBytes = new TextEncoder().encode("dingtalk attachment product-chain evidence\n");
    dingtalk.addAttachment({
      downloadCode: ATTACHMENT_CODE,
      fileName: "dingtalk-product-chain-note.txt",
      mimeType: "text/plain",
      bytes: attachmentBytes
    });

    fixture = await startSystem(dingtalk, ({ requestNumber }) => requestNumber === 1 ? FIRST_REPLY : GROUP_REPLY);
    const rootDirectory = fixture.rootDirectory;
    const paired = await fixture.pair("DingTalk Messaging E2 owner");
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
      channel: MessagingChannel.DINGTALK,
      dingtalkConfiguration: create(DingTalkMessagingConfigurationSchema, {
        appKey: DINGTALK_SYSTEM_APP_KEY,
        groupActivationRules: [{
          conversationId: DINGTALK_SYSTEM_GROUP_ID,
          activation: DingTalkGroupActivation.ALWAYS
        }]
      })
    })).connection, "created DingTalk connection");
    expect(created.ownerProviderUserId).toBeUndefined();
    const ticket = required((await paired.clients.messaging.beginMessagingCredentialUpload({
      connectionId: created.connectionId,
      expectedRevision: created.revision,
      expectedGeneration: created.generation
    })).ticket, "DingTalk credential upload ticket");
    const upload = await fetch(new URL(ticket.relativeEndpoint, fixture.baseUrl), {
      method: "PUT",
      headers: {
        authorization: `Bearer ${authKey}`,
        "content-type": "application/octet-stream"
      },
      body: Buffer.from(DINGTALK_SYSTEM_APP_SECRET)
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
        && connection.providerAccountId === DINGTALK_SYSTEM_APP_KEY
        && connection.ownerProviderUserId === undefined
        && connection.credentialConfigured),
      "the production DingTalk Stream worker to connect",
      15_000
    );

    dingtalk.enqueueDirectRichText({
      callbackMessageId: FIRST_CALLBACK_ID,
      messageId: FIRST_MESSAGE_ID,
      text: "Inspect the attached DingTalk note.",
      downloadCode: ATTACHMENT_CODE
    });
    await waitFor(
      async () => dingtalk?.callbackAcknowledgements ?? [],
      (acks) => acks.includes(FIRST_CALLBACK_ID),
      "the immediate DingTalk callback acknowledgement",
      10_000
    );
    await waitFor(
      async () => dingtalk?.outboundMessages ?? [],
      (messages) => messages.some((message) => message.text === FIRST_REPLY),
      "the real Pi reply to leave through the DingTalk session webhook",
      60_000
    );

    const claimed = fixture.application.store.getMessagingConnection(created.connectionId);
    expect(claimed.ownerProviderUserId).toBe(DINGTALK_SYSTEM_OWNER_ID);
    const firstRequest = required(
      fixture.application.store.listMessagingInboundRequests().find((request) =>
        request.providerRequestIds.includes(`dingtalk:callback:${FIRST_CALLBACK_ID}`)),
      "first DingTalk request"
    );
    expect(firstRequest).toMatchObject({
      status: "completed",
      providerMessageId: FIRST_MESSAGE_ID,
      protectedContent: false
    });
    expect(firstRequest.artifactIds).toHaveLength(1);
    const staged = fixture.application.store.getArtifact(firstRequest.artifactIds[0]!);
    expect((await fixture.application.artifacts.readBlob(staged.blob)).data).toEqual(Buffer.from(attachmentBytes));
    const directConversation = fixture.application.store.getMessagingConversation(firstRequest.conversationId!);
    expect(directConversation).toMatchObject({
      status: "active",
      providerConversationId: DINGTALK_SYSTEM_OWNER_ID,
      providerThreadId: ""
    });
    const directSessionId = required(directConversation.sessionId, "DingTalk direct task Session");
    expect((await paired.clients.session.getSession({ sessionId: directSessionId })).session).toMatchObject({
      sessionId: directSessionId,
      targetId: "workspace-real-pi",
      backendId: "pi"
    });
    expect(dingtalk.outboundMessages).toContainEqual(expect.objectContaining({
      target: DINGTALK_SYSTEM_OWNER_ID,
      text: FIRST_REPLY
    }));

    dingtalk.enqueueGroupText({
      callbackMessageId: GROUP_CALLBACK_ID,
      messageId: GROUP_MESSAGE_ID,
      text: "Handle this explicitly approved group message."
    });
    await waitFor(
      async () => dingtalk?.outboundMessages ?? [],
      (messages) => messages.some((message) => message.text === GROUP_REPLY),
      "the approved DingTalk group reply",
      60_000
    );
    const groupConversation = required(
      fixture.application.store.listMessagingConversations({ connectionId: created.connectionId })
        .find((conversation) => conversation.providerConversationId === DINGTALK_SYSTEM_GROUP_ID),
      "approved DingTalk group conversation"
    );
    expect(groupConversation).toMatchObject({ status: "active", providerThreadId: "" });
    expect(dingtalk.outboundMessages).toContainEqual(expect.objectContaining({
      target: DINGTALK_SYSTEM_GROUP_ID,
      text: GROUP_REPLY
    }));

    const streamConnectionsBeforeReconnect = dingtalk.streamConnections;
    const cursorBeforeReconnect = claimedCursor(fixture, created.connectionId);
    dingtalk.forceStreamReconnect();
    await waitFor(
      async () => dingtalk?.streamConnections ?? 0,
      (count) => count > streamConnectionsBeforeReconnect,
      "the DingTalk Stream worker to reconnect",
      15_000
    );
    await waitFor(
      async () => fixture!.application.store.getMessagingConnection(created.connectionId),
      (connection) => connection.runtimeStatus === "connected",
      "the reconnected DingTalk runtime projection",
      15_000
    );
    expect(claimedCursor(fixture, created.connectionId)).toBe(cursorBeforeReconnect);

    const persistedCursor = claimedCursor(fixture, created.connectionId);
    await fixture.close({ removeRoot: false });
    fixture = undefined;

    fixture = await startSystem(dingtalk, () => RESTART_REPLY, rootDirectory);
    const restartedClients = fixture.clients(authKey);
    expect(claimedCursor(fixture, created.connectionId)).toBe(persistedCursor);
    expect(fixture.application.store.getMessagingConnection(created.connectionId).ownerProviderUserId)
      .toBe(DINGTALK_SYSTEM_OWNER_ID);
    await waitFor(
      async () => fixture!.application.store.getMessagingConnection(created.connectionId),
      (connection) => connection.runtimeStatus === "connected",
      "the persisted DingTalk connection to reconnect after restart",
      15_000
    );

    dingtalk.enqueueDirectText({
      callbackMessageId: RESTART_CALLBACK_ID,
      messageId: RESTART_MESSAGE_ID,
      text: "Continue in the same claimed direct task after restart."
    });
    await waitFor(
      async () => dingtalk?.outboundMessages ?? [],
      (messages) => messages.some((message) => message.text === RESTART_REPLY),
      "the restarted DingTalk worker to deliver the direct reply",
      60_000
    );

    const requests = fixture.application.store.listMessagingInboundRequests();
    expect(requests).toHaveLength(3);
    expect(requests.flatMap((request) => request.providerRequestIds).sort()).toEqual([
      `dingtalk:callback:${FIRST_CALLBACK_ID}`,
      `dingtalk:callback:${GROUP_CALLBACK_ID}`,
      `dingtalk:callback:${RESTART_CALLBACK_ID}`
    ]);
    const restartedDirect = required(
      fixture.application.store.listMessagingConversations({ connectionId: created.connectionId })
        .find((conversation) => conversation.providerConversationId === DINGTALK_SYSTEM_OWNER_ID),
      "restarted DingTalk direct conversation"
    );
    expect(restartedDirect.sessionId).toBe(directSessionId);
    expect((await restartedClients.session.getSession({ sessionId: directSessionId })).session?.sessionId)
      .toBe(directSessionId);
    expect(fixture.providerRequests).toHaveLength(1);

    const durableProjection = JSON.stringify({
      settings: fixture.application.store.listSettings(),
      connections: fixture.application.store.listMessagingConnections(),
      requests,
      deliveries: fixture.application.store.listMessagingDeliveries(),
      diagnostics: fixture.application.store.listDiagnostics({ limit: 200 })
    }, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value);
    expect(durableProjection).not.toContain(DINGTALK_SYSTEM_APP_SECRET);
    expect(durableProjection).not.toContain(DINGTALK_SYSTEM_SESSION_CAPABILITY);
    expect(durableProjection).not.toContain(ATTACHMENT_CODE);
  });
});

async function startSystem(
  dingtalk: DingTalkSystemFixture,
  reply: (input: { readonly requestNumber: number }) => string,
  rootDirectory?: string
): Promise<RealPiSystemFixture> {
  return RealPiSystemFixture.start({
    ...(rootDirectory === undefined ? {} : { rootDirectory }),
    keepRoot: rootDirectory === undefined,
    dingTalkApiBaseUrl: dingtalk.baseUrl,
    dingTalkOapiBaseUrl: dingtalk.baseUrl,
    messagingPollTimeoutSeconds: 1,
    messagingRetryDelayMs: 250,
    providerResponder: ({ requestNumber }) => ({ kind: "text", text: reply({ requestNumber }) })
  });
}

function claimedCursor(fixture: RealPiSystemFixture, connectionId: string): string {
  const cursor = fixture.application.store.getMessagingConnection(connectionId).cursor;
  if (cursor === null || cursor === undefined) throw new Error("Missing DingTalk cursor.");
  return cursor;
}

function required<T>(value: T | null | undefined, label: string): T {
  if (value === undefined || value === null) throw new Error(`Missing ${label}.`);
  return value;
}
