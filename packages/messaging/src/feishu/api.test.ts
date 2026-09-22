import { Readable } from "node:stream";

import type * as Lark from "@larksuiteoapi/node-sdk";
import { describe, expect, it, vi } from "vitest";

import type { MessagingAddress } from "../types.js";
import { FeishuApi } from "./api.js";

const APP_SECRET = "private-feishu-app-secret";
const topicAddress: MessagingAddress = {
  channel: "feishu",
  connectionId: "connection-one",
  providerConversationId: "oc_group",
  providerThreadId: "omt_topic",
  conversationKind: "group"
};

describe("FeishuApi", () => {
  it("binds identity, topic history, replies, media, and reactions to the official client surface", async () => {
    const messageList = vi.fn(async (input: any) => input.params.page_size === 1
      ? { code: 0, data: { items: [{ message_id: "om_anchor", deleted: false }] } }
      : {
          code: 0,
          data: {
            items: [{
              message_id: "om_history",
              chat_id: "oc_group",
              thread_id: "omt_topic",
              msg_type: "text",
              body: { content: JSON.stringify({ text: "prior context" }) },
              sender: { id: "ou_guest", sender_name: "Guest", sender_type: "user" },
              create_time: "1790078400000",
              deleted: false
            }],
            has_more: false
          }
        });
    const messageCreate = vi.fn(async () => ({ code: 0, data: { message_id: "om_created" } }));
    const messageReply = vi.fn(async () => ({ code: 0, data: { message_id: "om_reply" } }));
    const fileCreate = vi.fn(async () => ({ file_key: "file_uploaded" }));
    const reactionCreate = vi.fn(async () => ({ code: 0 }));
    const client = {
      request: vi.fn(async () => ({
        code: 0,
        bot: { open_id: "ou_bot", app_name: "Joko Feishu bot" }
      })),
      im: { v1: {
        message: {
          list: messageList,
          create: messageCreate,
          reply: messageReply,
          get: vi.fn(async () => ({ code: 0, data: { items: [] } })),
          patch: vi.fn(async () => ({ code: 0 }))
        },
        messageResource: {
          get: vi.fn(async () => ({
            getReadableStream: () => Readable.from([new Uint8Array([1, 2, 3])]),
            headers: { "content-type": "text/plain" }
          }))
        },
        image: { create: vi.fn(async () => ({ image_key: "image_uploaded" })) },
        file: { create: fileCreate },
        messageReaction: { create: reactionCreate }
      } }
    } as unknown as Lark.Client;
    const api = new FeishuApi({
      appId: "cli_app",
      appSecret: APP_SECRET,
      service: "feishu",
      client
    });

    await expect(api.probe()).resolves.toEqual({
      appId: "cli_app",
      botOpenId: "ou_bot",
      displayName: "Joko Feishu bot"
    });
    await expect(api.listHistory(topicAddress, 20)).resolves.toEqual([
      expect.objectContaining({ messageId: "om_history", threadId: "omt_topic", senderOpenId: "ou_guest" })
    ]);
    expect(messageList).toHaveBeenCalledWith({
      params: expect.objectContaining({
        container_id_type: "thread",
        container_id: "omt_topic",
        page_size: 20
      })
    });
    await expect(api.sendText(topicAddress, "topic reply")).resolves.toBe("om_reply");
    expect(messageReply).toHaveBeenCalledWith({
      path: { message_id: "om_anchor" },
      data: {
        msg_type: "text",
        content: JSON.stringify({ text: "topic reply" }),
        reply_in_thread: true
      }
    });

    const directAddress: MessagingAddress = {
      channel: "feishu",
      connectionId: "connection-one",
      providerConversationId: "ou_owner",
      providerThreadId: null,
      conversationKind: "direct"
    };
    await expect(api.sendText(directAddress, "direct reply")).resolves.toBe("om_created");
    expect(messageCreate).toHaveBeenCalledWith({
      params: { receive_id_type: "open_id" },
      data: {
        receive_id: "ou_owner",
        msg_type: "text",
        content: JSON.stringify({ text: "direct reply" })
      }
    });
    await expect(api.sendAttachment(directAddress, {
      kind: "file",
      bytes: new Uint8Array([4, 5]),
      fileName: "evidence.txt",
      mimeType: "text/plain"
    })).resolves.toBe("om_created");
    expect(fileCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ file_type: "stream", file_name: "evidence.txt" })
    });
    await expect(api.downloadAttachment({
      messageId: "om_source",
      providerKey: "file_provider",
      kind: "file",
      maximumBytes: 3
    })).resolves.toEqual({
      bytes: Buffer.from([1, 2, 3]),
      fileName: "file_provider",
      mimeType: "text/plain"
    });
    await api.addReaction("om_source", "DONE");
    expect(reactionCreate).toHaveBeenCalledWith({
      path: { message_id: "om_source" },
      data: { reaction_type: { emoji_type: "DONE" } }
    });
  });

  it("classifies credential and uncertain write failures without reflecting the App Secret", async () => {
    const rejected = new FeishuApi({
      appId: "cli_app",
      appSecret: APP_SECRET,
      service: "lark",
      client: {
        request: vi.fn(async () => ({ code: 99991663, msg: `invalid app secret ${APP_SECRET}` }))
      } as unknown as Lark.Client
    });
    const credentialFailure = await rejected.probe().catch((error: unknown) => error);
    expect(credentialFailure).toMatchObject({
      code: "invalid_credential",
      options: { retryable: false, effect: "none" }
    });
    expect(String(credentialFailure)).not.toContain(APP_SECRET);

    const uncertain = new FeishuApi({
      appId: "cli_app",
      appSecret: APP_SECRET,
      service: "feishu",
      client: {
        im: { v1: { message: {
          create: vi.fn(async () => { throw new TypeError("socket reset"); })
        } } }
      } as unknown as Lark.Client
    });
    await expect(uncertain.sendText({
      channel: "feishu",
      connectionId: "connection-one",
      providerConversationId: "ou_owner",
      providerThreadId: null,
      conversationKind: "direct"
    }, "hello")).rejects.toMatchObject({
      code: "provider_unavailable",
      options: { retryable: true, effect: "unknown" }
    });
  });
});
