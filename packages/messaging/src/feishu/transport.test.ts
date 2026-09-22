import { describe, expect, it, vi } from "vitest";

import type { MessagingAddress } from "../types.js";
import { FEISHU_MAXIMUM_IMAGE_BYTES, type FeishuApiPort } from "./api.js";
import { FeishuStreamClient } from "./stream.js";
import { FeishuTransport } from "./transport.js";

const NOW = Date.UTC(2026, 8, 22, 12, 0, 0);

describe("FeishuTransport", () => {
  it("claims an owner and binds downloads, history, topic replies, attachments, cards, and reactions to provider effects", async () => {
    let handlers: Readonly<Record<string, (value: unknown) => unknown>> = {};
    const stream = new FeishuStreamClient({
      appId: "cli_app",
      appSecret: "private-app-secret",
      service: "feishu",
      connectionId: "connection-one",
      now: () => NOW,
      createDispatcher: (value) => {
        handlers = value;
        return value;
      },
      createClient: (callbacks) => ({
        start: async () => { callbacks.onReady(); },
        close: vi.fn()
      })
    });
    const api = fakeApi();
    const transport = new FeishuTransport({
      appId: "cli_app",
      appSecret: "private-app-secret",
      service: "feishu",
      connectionId: "connection-one",
      generation: 3,
      ownerUserId: null,
      groupActivation: { oc_group: "mention" },
      now: () => NOW,
      api,
      stream
    });

    await expect(transport.probe()).resolves.toMatchObject({
      channel: "feishu",
      providerAccountId: "cli_app",
      displayName: "Joko Bot"
    });
    handlers["im.message.receive_v1"]!({
      sender: { sender_id: { open_id: "ou_owner" }, sender_type: "user", sender_name: "Owner" },
      message: {
        message_id: "om_file",
        chat_id: "oc_direct",
        chat_type: "p2p",
        message_type: "file",
        content: JSON.stringify({ file_key: "file-provider-key", file_name: "evidence.txt", file_size: 3 }),
        create_time: String(NOW)
      }
    });
    const polled = await transport.poll({ cursor: null, timeoutSeconds: 0 });
    const normalized = transport.normalize(polled.updates);
    expect(normalized.ownerClaimProviderUserId).toBe("ou_owner");
    const inbound = normalized.events[0];
    if (inbound?.kind !== "message") throw new Error("Expected an inbound message.");
    await expect(transport.downloadAttachment(inbound.attachments[0]!)).resolves.toEqual({
      bytes: new Uint8Array([1, 2, 3]),
      fileName: "evidence.txt",
      mimeType: "text/plain"
    });
    expect(api.downloadAttachment).toHaveBeenCalledWith(expect.objectContaining({
      messageId: "om_file",
      providerKey: "file-provider-key",
      kind: "file",
      maximumBytes: 3
    }));

    handlers["im.message.receive_v1"]!({
      sender: { sender_id: { open_id: "ou_owner" }, sender_type: "user", sender_name: "Owner" },
      message: {
        message_id: "om_image",
        chat_id: "oc_direct",
        chat_type: "p2p",
        message_type: "image",
        content: JSON.stringify({ image_key: "image-provider-key", file_size: FEISHU_MAXIMUM_IMAGE_BYTES + 1 }),
        create_time: String(NOW)
      }
    });
    const imagePoll = await transport.poll({ cursor: polled.nextCursor, timeoutSeconds: 0 });
    const imageInbound = transport.normalize(imagePoll.updates).events[0];
    if (imageInbound?.kind !== "message") throw new Error("Expected an inbound image message.");
    await transport.downloadAttachment(imageInbound.attachments[0]!);
    expect(api.downloadAttachment).toHaveBeenLastCalledWith(expect.objectContaining({
      messageId: "om_image",
      providerKey: "image-provider-key",
      kind: "image",
      maximumBytes: FEISHU_MAXIMUM_IMAGE_BYTES
    }));

    const ownerAddress = transport.ownerAddress();
    expect(ownerAddress).toMatchObject({ providerConversationId: "ou_owner", conversationKind: "direct" });
    await expect(transport.sendTextPart({ address: ownerAddress, text: "reply" }))
      .resolves.toMatchObject({ providerMessageId: "om_text" });
    await expect(transport.sendAttachments({
      address: ownerAddress,
      attachments: [{
        kind: "file",
        bytes: new Uint8Array([4, 5]),
        fileName: "result.txt",
        mimeType: "text/plain"
      }]
    })).resolves.toMatchObject({ providerMessageId: "om_attachment" });
    const topicAddress: MessagingAddress = {
      channel: "feishu",
      connectionId: "connection-one",
      providerConversationId: "oc_group",
      providerThreadId: "omt_topic",
      conversationKind: "group"
    };
    await expect(transport.loadGroupHistory(topicAddress)).resolves.toEqual([
      expect.objectContaining({
        messageId: "om_history",
        address: expect.objectContaining({ providerThreadId: "omt_topic" })
      })
    ]);
    await expect(transport.sendInteractionCard({
      address: topicAddress,
      text: "Allow this operation?",
      buttons: [{ label: "Allow", actionValue: "choice:allow" }]
    })).resolves.toMatchObject({ providerMessageId: "om_card" });
    expect(api.sendCard).toHaveBeenCalledWith(topicAddress, expect.objectContaining({
      elements: expect.arrayContaining([expect.objectContaining({ tag: "action" })])
    }), undefined);
    await transport.clearInteractionCard({ address: topicAddress, messageId: "om_card" });
    await transport.setReaction({ address: topicAddress, messageId: "om_source", emoji: "✅" });
    expect(api.patchCard).toHaveBeenCalledWith("om_card", expect.any(Object), undefined);
    expect(api.addReaction).toHaveBeenCalledWith("om_source", "DONE", undefined);
    await transport.close();
  });
});

function fakeApi(): FeishuApiPort {
  return {
    probe: vi.fn(async () => ({ appId: "cli_app", botOpenId: "ou_bot", displayName: "Joko Bot" })),
    downloadAttachment: vi.fn(async () => ({
      bytes: new Uint8Array([1, 2, 3]),
      fileName: "file-provider-key",
      mimeType: "text/plain"
    })),
    resolveReplyContext: vi.fn(async () => null),
    listHistory: vi.fn(async (address) => [{
      messageId: "om_history",
      chatId: address.providerConversationId,
      threadId: address.providerThreadId,
      senderOpenId: "ou_guest",
      senderName: "Guest",
      senderIsBot: false,
      messageType: "text",
      content: JSON.stringify({ text: "prior context" }),
      occurredAt: NOW - 1_000
    }]),
    sendText: vi.fn(async () => "om_text"),
    sendAttachment: vi.fn(async () => "om_attachment"),
    sendCard: vi.fn(async () => "om_card"),
    patchCard: vi.fn(async () => undefined),
    addReaction: vi.fn(async () => undefined)
  };
}
