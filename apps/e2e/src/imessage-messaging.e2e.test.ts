import { create } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import { IMessageGroupActivation, IMessageMessagingConfigurationSchema, MessagingChannel,
  MessagingConnectionRuntimeStatus, PermissionMode } from "@joko/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { waitFor } from "./fixture.js";
import { REAL_PI_MODEL_ID, REAL_PI_PROVIDER_ID, RealPiSystemFixture } from "./real-pi-fixture.js";
import { IMESSAGE_SYSTEM_DIRECT, IMESSAGE_SYSTEM_FILE, IMESSAGE_SYSTEM_GROUP, IMESSAGE_SYSTEM_GUEST, IMESSAGE_SYSTEM_OWNER,
  IMESSAGE_SYSTEM_PASSWORD, startIMessageSystemFixture } from "./imessage-system-fixture.js";

describe("iMessage Messaging production product chain", () => {
  let blueBubbles: Awaited<ReturnType<typeof startIMessageSystemFixture>> | undefined;
  let fixture: RealPiSystemFixture | undefined;
  afterEach(async () => {
    await fixture?.close({ removeRoot: true });
    await blueBubbles?.close();
    fixture = undefined;
    blueBubbles = undefined;
  });

  it("routes approved owner and guest chats, ingests the attachment, and keeps one unknown receipt across polls", { timeout: 120_000 }, async () => {
    const bridge = blueBubbles = await startIMessageSystemFixture();
    const app = fixture = await RealPiSystemFixture.start({
      providerResponder: ({ requestNumber }) => ({ kind: "text", text: `iMessage product reply ${requestNumber}` })
    });
    const { clients, authKey } = await app.pair("iMessage settings owner");
    const configuration = create(IMessageMessagingConfigurationSchema, {
      serverOrigin: bridge.origin, aliases: ["Joko"],
      chats: [{ chatGuid: IMESSAGE_SYSTEM_DIRECT, activation: IMessageGroupActivation.ALWAYS, selfAddress: IMESSAGE_SYSTEM_OWNER },
        { chatGuid: IMESSAGE_SYSTEM_GROUP, activation: IMessageGroupActivation.MENTION }]
    });
    const createInput = { channel: MessagingChannel.IMESSAGE, ownerProviderUserId: IMESSAGE_SYSTEM_OWNER, imessageConfiguration: configuration };
    await expect(app.anonymous.messaging.createMessagingConnection(createInput)).rejects.toMatchObject({ code: Code.Unauthenticated });
    await clients.messaging.putMessagingRoute({
      targetId: "workspace-real-pi", providerId: REAL_PI_PROVIDER_ID, modelId: REAL_PI_MODEL_ID,
      effort: "off", permissionMode: PermissionMode.ASK, fastMode: false, planMode: false
    });
    bridge.receive({ guid: "before-approval", chatGuid: IMESSAGE_SYSTEM_DIRECT, sender: IMESSAGE_SYSTEM_OWNER,
      text: "Earlier conversation before authorization", at: Date.now() - 60_000 });
    const created = (await clients.messaging.createMessagingConnection(createInput)).connection!;
    expect(created.imessageConfiguration).toEqual(configuration);
    expect(created.credentialConfigured).toBe(false);
    const ticket = (await clients.messaging.beginMessagingCredentialUpload({ connectionId: created.connectionId,
      expectedRevision: created.revision, expectedGeneration: created.generation })).ticket!;
    expect((await fetch(new URL(ticket.relativeEndpoint, app.baseUrl), {
      method: "PUT", headers: { authorization: `Bearer ${authKey}`, "content-type": "application/octet-stream" },
      body: Buffer.from(IMESSAGE_SYSTEM_PASSWORD)
    })).status).toBe(204);
    await clients.messaging.commitMessagingCredential({ credentialUploadTicketId: ticket.ticketId, enable: true });
    const settings = async () => (await clients.messaging.getMessagingSettings({})).connections.find(item => item.connectionId === created.connectionId);
    await waitFor(settings, value => value?.runtimeStatus === MessagingConnectionRuntimeStatus.CONNECTED, "iMessage provider validation", 20_000);
    const receive = (guid: string, chatGuid: string, sender: string, text: string, attachment?: typeof IMESSAGE_SYSTEM_FILE) =>
      bridge.receive({ guid, chatGuid, sender, text, attachment });
    receive("owner-direct", IMESSAGE_SYSTEM_DIRECT, IMESSAGE_SYSTEM_OWNER, "Reply to the verified owner direct chat");
    const effects = async () => [...bridge.sent];
    await waitFor(effects, value => value.length === 1, "physical BlueBubbles direct reply", 35_000);
    expect(bridge.sent[0]).toMatchObject({ chatGuid: IMESSAGE_SYSTEM_DIRECT, message: "iMessage product reply 1", method: "apple-script" });
    receive("group-ambient", IMESSAGE_SYSTEM_GROUP, IMESSAGE_SYSTEM_GUEST, "Ambient group context for the next task");
    receive("outside-scope", "any;+;unapproved-chat", IMESSAGE_SYSTEM_GUEST, "@Joko this chat was not approved");
    const store = app.application.store;
    const requests = () => store.listMessagingInboundRequests({ connectionId: created.connectionId });
    await waitFor(async () => {
      const conversation = store.listMessagingConversations({ connectionId: created.connectionId }).find(item => item.conversationKind === "group");
      return conversation && store.findMessagingGroupObservation(conversation.id, "group-ambient");
    }, value => value !== undefined, "ambient chat history without task admission", 15_000);
    expect(requests().map(item => item.providerMessageId)).toEqual(["owner-direct"]);
    receive("group-invoked", IMESSAGE_SYSTEM_GROUP, IMESSAGE_SYSTEM_GUEST, "@Joko check this attachment", IMESSAGE_SYSTEM_FILE);
    await waitFor(effects, value => value.length === 2, "physical BlueBubbles group reply", 35_000);
    expect(bridge.sent[1]).toMatchObject({ chatGuid: IMESSAGE_SYSTEM_GROUP, message: "iMessage product reply 2", method: "private-api" });
    const group = requests().find(item => item.providerMessageId === "group-invoked")!;
    const owner = requests().find(item => item.providerMessageId === "owner-direct")!;
    expect(group.conversationId).not.toBe(owner.conversationId);
    expect(JSON.stringify(app.providerRequests[1]?.body)).toContain("Ambient group context for the next task");
    expect(bridge.downloads).toEqual([IMESSAGE_SYSTEM_FILE.guid]);
    expect(group.artifactIds.map(id => store.getArtifact(id).blob)).toContainEqual(expect.objectContaining({
      fileName: IMESSAGE_SYSTEM_FILE.transferName, byteLength: IMESSAGE_SYSTEM_FILE.totalBytes
    }));

    bridge.loseNextReceipt();
    receive("uncertain-owner", IMESSAGE_SYSTEM_DIRECT, IMESSAGE_SYSTEM_OWNER, "Send a reply whose receipt then drops");
    const unknown = await waitFor(async () => store.listMessagingDeliveries({ connectionId: created.connectionId, statuses: ["unknown"] }),
      rows => rows.length === 1, "an uncertain outbox receipt", 35_000);
    expect(unknown[0]).toMatchObject({ kind: "text", attempts: 1 });
    const polls = bridge.queries.length;
    await waitFor(async () => bridge.queries.length, count => count >= polls + 4, "two later overlap polls", 15_000);
    expect(bridge.sent).toHaveLength(3);
    expect(requests().map(item => item.providerMessageId).sort()).toEqual(["group-invoked", "owner-direct", "uncertain-owner"]);
    const latest = (await settings())!;
    await clients.messaging.clearMessagingCredential({ connectionId: latest.connectionId,
      expectedRevision: latest.revision, expectedGeneration: latest.generation });
    const cleared = (await settings())!;
    expect(cleared).toMatchObject({ enabled: false, credentialConfigured: false });
    expect(cleared.generation > latest.generation).toBe(true);
    expect(bridge.errors).toEqual([]);
  });
});
