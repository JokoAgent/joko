import { create } from "@bufbuild/protobuf";
import {
  MessagingChannel,
  MessagingConnectionRuntimeStatus,
  PermissionMode,
  SlackEmojiReactions,
  SlackGroupActivation,
  SlackMessagingConfigurationSchema
} from "@joko/contracts";
import { SlackTransport } from "@joko/messaging";
import { afterEach, describe, expect, it } from "vitest";

import { waitFor } from "./fixture.js";
import {
  REAL_PI_MODEL_ID,
  REAL_PI_PROVIDER_ID,
  RealPiSystemFixture
} from "./real-pi-fixture.js";
import {
  SLACK_SYSTEM_APP_TOKEN,
  SLACK_SYSTEM_BOT_TOKEN,
  SLACK_SYSTEM_CHANNEL_ID,
  SLACK_SYSTEM_DM_ID,
  SLACK_SYSTEM_FILE_ID,
  SLACK_SYSTEM_BOT_USER_ID,
  SLACK_SYSTEM_OWNER_ID,
  SLACK_SYSTEM_STRANGER_ID,
  SLACK_SYSTEM_TEAM_ID,
  SlackSystemFixture
} from "./slack-system-fixture.js";

const DM_REPLY = "SLACK_E2_DM_REPLY: the owner DM reached its durable task.";
const THREAD_REPLY = "SLACK_E2_THREAD_REPLY: the attachment reached the approved thread task.";
const RECONNECT_REPLY = "SLACK_E2_RECONNECT_REPLY: the live socket resumed this thread task.";
const RESTART_REPLY = "SLACK_E2_RESTART_REPLY: the same thread task resumed after restart.";

describe("Slack Messaging production product chain", () => {
  let fixture: RealPiSystemFixture | undefined;
  let slack: SlackSystemFixture | undefined;

  afterEach(async () => {
    await fixture?.close({ removeRoot: true });
    fixture = undefined;
    await slack?.close();
    slack = undefined;
  });

  it("uses authenticated Connect, direct Socket Mode and Web API, owner DM, approved thread attachment, durable ACK, and restart recovery", { timeout: 180_000 }, async () => {
    slack = await SlackSystemFixture.start();
    const attachmentBytes = new TextEncoder().encode("Slack attachment product-chain evidence\n");
    slack.addAttachment({ id: SLACK_SYSTEM_FILE_ID, name: "slack-product-chain-note.txt", mimeType: "text/plain", bytes: attachmentBytes });
    const rootTs = slack.timestamp();
    fixture = await startSystem(slack, ({ requestNumber }) =>
      requestNumber === 1 ? DM_REPLY : requestNumber === 2 ? THREAD_REPLY : RECONNECT_REPLY);
    const rootDirectory = fixture.rootDirectory;
    const admittedAtAcknowledgement = new Map<string, Map<string, boolean>>();
    slack.onAcknowledge = (envelopeId) => {
      const snapshot = new Map<string, boolean>();
      const store = fixture?.application.store;
      if (store !== undefined) {
        for (const request of store.listMessagingInboundRequests()) {
          if (request.providerMessageId === undefined) continue;
          let admitted = false;
          if (request.status !== "preparing" && request.conversationId !== undefined
            && request.operationId !== undefined && request.runId !== undefined
            && request.attemptId !== undefined && request.queueItemId !== undefined) {
            const conversation = store.getMessagingConversation(request.conversationId);
            const queueItem = store.getQueueItem(request.queueItemId);
            admitted = conversation.sessionId !== undefined && queueItem.sessionId === conversation.sessionId;
          }
          snapshot.set(request.providerMessageId, admitted);
        }
      }
      admittedAtAcknowledgement.set(envelopeId, snapshot);
    };
    const paired = await fixture.pair("Slack Messaging E2 owner");
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
      channel: MessagingChannel.SLACK,
      ownerProviderUserId: SLACK_SYSTEM_OWNER_ID,
      slackConfiguration: create(SlackMessagingConfigurationSchema, {
        lifecycleAnnouncements: false,
        emojiReactions: SlackEmojiReactions.MINIMAL,
        groupActivationRules: [{ channelId: SLACK_SYSTEM_CHANNEL_ID, activation: SlackGroupActivation.MENTION }]
      })
    })).connection, "created Slack connection");
    const ticket = required((await paired.clients.messaging.beginMessagingCredentialUpload({
      connectionId: created.connectionId,
      expectedRevision: created.revision,
      expectedGeneration: created.generation
    })).ticket, "Slack credential upload ticket");
    const upload = await fetch(new URL(ticket.relativeEndpoint, fixture.baseUrl), {
      method: "PUT",
      headers: { authorization: `Bearer ${authKey}`, "content-type": "application/octet-stream" },
      body: Buffer.from(JSON.stringify({ format: 1, appToken: SLACK_SYSTEM_APP_TOKEN, botToken: SLACK_SYSTEM_BOT_TOKEN }))
    });
    expect(upload.status).toBe(204);
    await paired.clients.messaging.commitMessagingCredential({ credentialUploadTicketId: ticket.ticketId, enable: true });
    await waitFor(
      () => paired.clients.messaging.getMessagingSettings({}),
      (settings) => settings.connections.some((connection) =>
        connection.connectionId === created.connectionId
        && connection.runtimeStatus === MessagingConnectionRuntimeStatus.CONNECTED
        && connection.providerAccountId === SLACK_SYSTEM_TEAM_ID
        && connection.credentialConfigured),
      "the production Slack worker to connect",
      15_000
    );

    const dm = slack.enqueueMessage({ channelId: SLACK_SYSTEM_DM_ID, text: "Start this task from my owner DM." });
    await waitFor(
      async () => slack?.outboundMessages ?? [],
      (messages) => messages.some((message) => message.channelId === SLACK_SYSTEM_DM_ID && message.text === DM_REPLY),
      "the real Pi DM reply to leave through Slack Web API",
      60_000
    );
    await waitFor(async () => slack?.acknowledgements ?? [], (acks) => acks.includes(dm.envelopeId), "DM envelope ACK after durable admission", 10_000);
    expect(admittedAtAcknowledgement.get(dm.envelopeId)?.get(dm.ts)).toBe(true);
    await waitFor(
      async () => slack?.reactions ?? [],
      (reactions) => reactions.some((reaction) => reaction.method === "reactions.add"
        && reaction.channel === SLACK_SYSTEM_DM_ID && reaction.timestamp === dm.ts && reaction.name === "+1"),
      "terminal success reaction on the exact owner DM source",
      10_000
    );
    expect(slack.reactions).toContainEqual({ method: "reactions.add", channel: SLACK_SYSTEM_DM_ID, timestamp: dm.ts, name: "eyes" });
    expect(slack.reactions).toContainEqual({ method: "reactions.remove", channel: SLACK_SYSTEM_DM_ID, timestamp: dm.ts, name: "eyes" });
    const slashStatus = slack.enqueueSlashCommand("status");
    await waitFor(async () => slack?.acknowledgements ?? [], (acks) => acks.includes(slashStatus), "owner DM slash-command ACK", 10_000);
    await waitFor(
      async () => slack?.outboundMessages ?? [],
      (messages) => messages.some((message) => message.channelId === SLACK_SYSTEM_DM_ID && message.text.startsWith("Slack connection: connected.")),
      "owner DM slash-command status response",
      10_000
    );

    const thread = slack.enqueueMessage({
      channelId: SLACK_SYSTEM_CHANNEL_ID,
      threadTs: rootTs,
      text: `<@${SLACK_SYSTEM_BOT_USER_ID}> Inspect the attached note in this approved channel thread.`,
      fileId: SLACK_SYSTEM_FILE_ID
    });
    await waitFor(
      async () => slack?.outboundMessages ?? [],
      (messages) => messages.some((message) => message.channelId === SLACK_SYSTEM_CHANNEL_ID && message.text === THREAD_REPLY),
      "the real Pi thread reply to leave through Slack Web API",
      60_000
    );
    await waitFor(async () => slack?.acknowledgements ?? [], (acks) => acks.includes(thread.envelopeId), "thread envelope ACK after durable admission", 10_000);
    expect(admittedAtAcknowledgement.get(thread.envelopeId)?.get(thread.ts)).toBe(true);
    await waitFor(
      async () => slack?.reactions ?? [],
      (reactions) => reactions.some((reaction) => reaction.method === "reactions.add"
        && reaction.channel === SLACK_SYSTEM_CHANNEL_ID && reaction.timestamp === thread.ts && reaction.name === "+1"),
      "terminal success reaction on the exact channel thread source",
      10_000
    );
    expect(slack.reactions).toContainEqual({ method: "reactions.add", channel: SLACK_SYSTEM_CHANNEL_ID, timestamp: thread.ts, name: "eyes" });
    expect(slack.reactions).toContainEqual({ method: "reactions.remove", channel: SLACK_SYSTEM_CHANNEL_ID, timestamp: thread.ts, name: "eyes" });

    const threadStatus = slack.enqueueMessage({ channelId: SLACK_SYSTEM_CHANNEL_ID, threadTs: rootTs, text: "!status" });
    await waitFor(async () => slack?.acknowledgements ?? [], (acks) => acks.includes(threadStatus.envelopeId), "thread command ACK", 10_000);
    await waitFor(
      async () => slack?.outboundMessages ?? [],
      (messages) => messages.some((message) => message.channelId === SLACK_SYSTEM_CHANNEL_ID
        && message.threadTs === rootTs && message.text.startsWith("Slack connection: connected.")),
      "thread !status response",
      10_000
    );
    const progressIndex = await waitFor(
      async () => slack!.outboundMessages.findIndex((message) => message.channelId === SLACK_SYSTEM_CHANNEL_ID
        && message.threadTs === rootTs && message.text === "Working on this task…"),
      (index) => index >= 0,
      "the durable Slack thread progress placeholder",
      10_000
    );
    const progressMessageId = required(slack.outboundMessageIds[progressIndex], "Slack thread progress message ID");
    await waitFor(
      async () => slack?.updatedMessages ?? [],
      (updates) => updates.some((update) => update.channelId === SLACK_SYSTEM_CHANNEL_ID
        && update.messageId === progressMessageId && update.text === "Task completed."),
      "the final Slack progress edit in place",
      10_000
    );

    const requests = fixture.application.store.listMessagingInboundRequests();
    expect(requests).toHaveLength(2);
    const threadRequest = required(requests.find((request) => request.providerMessageId === thread.ts), "Slack thread request");
    expect(threadRequest).toMatchObject({
      status: "completed",
      protectedContent: false
    });
    expect(threadRequest.providerRequestIds).toContain(`slack:message:${SLACK_SYSTEM_TEAM_ID}:${SLACK_SYSTEM_CHANNEL_ID}:${thread.ts}`);
    expect(threadRequest.providerRequestIds).toHaveLength(2);
    const progressDeliveries = fixture.application.store.listMessagingDeliveries();
    expect(progressDeliveries).toContainEqual(expect.objectContaining({
      dedupeKey: `request:${threadRequest.id}:progress:start`,
      status: "sent",
      providerMessageId: progressMessageId
    }));
    expect(progressDeliveries).toContainEqual(expect.objectContaining({
      dedupeKey: `request:${threadRequest.id}:progress:final`,
      status: "sent",
      providerMessageId: progressMessageId
    }));
    expect(threadRequest.artifactIds).toHaveLength(1);
    const staged = fixture.application.store.getArtifact(threadRequest.artifactIds[0]!);
    expect((await fixture.application.artifacts.readBlob(staged.blob)).data).toEqual(Buffer.from(attachmentBytes));
    const conversation = fixture.application.store.getMessagingConversation(threadRequest.conversationId!);
    expect(conversation).toMatchObject({
      status: "active",
      providerConversationId: `${SLACK_SYSTEM_TEAM_ID}/${SLACK_SYSTEM_CHANNEL_ID}`,
      providerThreadId: rootTs
    });
    const sessionId = required(conversation.sessionId, "Slack thread task Session");
    expect((await paired.clients.session.getSession({ sessionId })).session).toMatchObject({
      sessionId, targetId: "workspace-real-pi", backendId: "pi"
    });
    expect(slack.outboundMessages).toContainEqual({ channelId: SLACK_SYSTEM_CHANNEL_ID, text: THREAD_REPLY, threadTs: rootTs });
    expect(fixture.providerRequests).toHaveLength(2);

    const unaddressedRootTs = slack.timestamp();
    const requestsBeforeStranger = fixture.application.store.listMessagingInboundRequests().length;
    const sessionsBeforeStranger = fixture.application.store.listSessions().length;
    const stranger = slack.enqueueMessage({
      channelId: SLACK_SYSTEM_CHANNEL_ID,
      threadTs: unaddressedRootTs,
      userId: SLACK_SYSTEM_STRANGER_ID,
      text: "An unmentioned message in a different channel thread must not open a task."
    });
    await waitFor(async () => slack?.acknowledgements ?? [], (acks) => acks.includes(stranger.envelopeId), "unaddressed stranger thread ACK", 10_000);
    expect(fixture.application.store.listMessagingInboundRequests()).toHaveLength(requestsBeforeStranger);
    expect(fixture.application.store.listSessions()).toHaveLength(sessionsBeforeStranger);
    expect(fixture.application.store.listMessagingConversations({ connectionId: created.connectionId })
      .some((item) => item.providerThreadId === unaddressedRootTs)).toBe(false);

    const cursorBeforeReconnect = fixture.application.store.getMessagingConnection(created.connectionId).cursor;
    slack.forceSocketReconnect();
    const afterReconnect = slack.enqueueMessage({ channelId: SLACK_SYSTEM_CHANNEL_ID, threadTs: rootTs, text: "Continue this thread after the live socket reconnects." });
    await waitFor(async () => slack?.acknowledgements ?? [], (acks) => acks.includes(afterReconnect.envelopeId), "live Socket Mode reconnect and ACK", 15_000);
    await waitFor(
      async () => slack?.outboundMessages ?? [],
      (messages) => messages.some((message) => message.channelId === SLACK_SYSTEM_CHANNEL_ID && message.text === RECONNECT_REPLY),
      "the reconnected worker to finish the admitted thread request",
      60_000
    );
    await waitFor(
      async () => fixture!.application.store.getMessagingConnection(created.connectionId).cursor,
      (cursor) => cursor !== cursorBeforeReconnect,
      "the reconnected Slack cursor to persist",
      10_000
    );
    const persistedCursor = fixture.application.store.getMessagingConnection(created.connectionId).cursor;
    await fixture.close({ removeRoot: false });
    fixture = undefined;

    fixture = await startSystem(slack, () => RESTART_REPLY, rootDirectory);
    const restartedClients = fixture.clients(authKey);
    await waitFor(
      async () => fixture!.application.store.getMessagingConnection(created.connectionId),
      (connection) => connection.runtimeStatus === "connected" && connection.cursor === persistedCursor,
      "the persisted Slack connection to reconnect after restart",
      15_000
    );
    const resumed = slack.enqueueMessage({ channelId: SLACK_SYSTEM_CHANNEL_ID, threadTs: rootTs, text: "Continue in the same visible thread after restart." });
    await waitFor(async () => slack?.acknowledgements ?? [], (acks) => acks.includes(resumed.envelopeId), "restarted envelope ACK", 15_000);
    await waitFor(
      async () => slack?.outboundMessages ?? [],
      (messages) => messages.some((message) => message.channelId === SLACK_SYSTEM_CHANNEL_ID && message.text === RESTART_REPLY),
      "the restarted worker to deliver the thread reply",
      60_000
    );
    const restartedConversation = required(
      fixture.application.store.listMessagingConversations({ connectionId: created.connectionId })
        .find((item) => item.providerThreadId === rootTs),
      "restarted Slack thread conversation"
    );
    expect(restartedConversation.sessionId).toBe(sessionId);
    expect((await restartedClients.session.getSession({ sessionId })).session?.sessionId).toBe(sessionId);
    expect(fixture.providerRequests).toHaveLength(1);
    expect(fixture.application.store.listMessagingInboundRequests().filter((request) => request.providerMessageId === resumed.ts)).toHaveLength(1);
    const durableProjection = JSON.stringify({
      settings: fixture.application.store.listSettings(),
      connections: fixture.application.store.listMessagingConnections(),
      requests: fixture.application.store.listMessagingInboundRequests(),
      deliveries: fixture.application.store.listMessagingDeliveries(),
      diagnostics: fixture.application.store.listDiagnostics({ limit: 200 })
    }, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value);
    expect(durableProjection).not.toContain(SLACK_SYSTEM_APP_TOKEN);
    expect(durableProjection).not.toContain(SLACK_SYSTEM_BOT_TOKEN);
  });
});

async function startSystem(
  slack: SlackSystemFixture,
  reply: (input: { readonly requestNumber: number }) => string,
  rootDirectory?: string
): Promise<RealPiSystemFixture> {
  return RealPiSystemFixture.start({
    ...(rootDirectory === undefined ? {} : { rootDirectory }),
    keepRoot: rootDirectory === undefined,
    createSlackTransport: (options) => new SlackTransport({ ...options, apiBaseUrl: slack.apiBaseUrl }),
    messagingPollTimeoutSeconds: 1,
    messagingRetryDelayMs: 250,
    providerResponder: ({ requestNumber }) => ({ kind: "text", text: reply({ requestNumber }) })
  });
}

function required<T>(value: T | null | undefined, label: string): T {
  if (value === undefined || value === null) throw new Error(`Missing ${label}.`);
  return value;
}
