import { describe, expect, it, vi } from "vitest";

import { FeishuStreamClient } from "./stream.js";

const NOW = Date.UTC(2026, 8, 22, 12, 0, 0);

describe("FeishuStreamClient", () => {
  it("receives Lark messages and card actions through the official dispatcher without persisting the secret", async () => {
    let handlers: Readonly<Record<string, (value: unknown) => unknown>> = {};
    const close = vi.fn();
    const client = new FeishuStreamClient({
      appId: "cli_app",
      appSecret: "private-app-secret",
      service: "lark",
      connectionId: "connection-one",
      now: () => NOW,
      createDispatcher: (value) => {
        handlers = value;
        return value;
      },
      createClient: (callbacks) => ({
        start: async () => { callbacks.onReady(); },
        close
      })
    });

    await client.connect();
    handlers["im.message.receive_v1"]!({
      sender: {
        sender_id: { open_id: "ou_owner" },
        sender_type: "user",
        sender_name: "Owner"
      },
      message: {
        message_id: "om_message",
        chat_id: "oc_group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "@_user_1 hello" }),
        thread_id: "omt_topic",
        create_time: String(NOW),
        mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "Joko" }]
      }
    });
    const toast = handlers["card.action.trigger"]!({
      operator: { open_id: "ou_owner" },
      context: { open_message_id: "om_card", open_chat_id: "oc_group" },
      action: {
        value: {
          id: "choice:allow",
          joko_address: {
            channel: "lark",
            connection_id: "connection-one",
            conversation_id: "oc_group",
            thread_id: "omt_topic",
            conversation_kind: "group"
          }
        }
      }
    });

    const result = await client.poll({ cursor: null, timeoutSeconds: 0 });
    expect(result.updates).toEqual([
      expect.objectContaining({
        callbackId: "message:om_message",
        kind: "message",
        message: expect.objectContaining({
          chatId: "oc_group",
          threadId: "omt_topic",
          senderOpenId: "ou_owner"
        })
      }),
      expect.objectContaining({
        kind: "card_action",
        action: expect.objectContaining({
          actionValue: "choice:allow",
          address: expect.objectContaining({ providerThreadId: "omt_topic" })
        })
      })
    ]);
    expect(toast).toEqual({ toast: { type: "success", content: "Response received" } });
    expect(result.nextCursor).toBe("card:om_card:ou_owner:choice:allow");
    expect(JSON.stringify(result)).not.toContain("private-app-secret");
    await client.close();
    expect(close).toHaveBeenCalledWith({ force: true });
  });

  it("classifies the provider connection limit as a terminal conflict", async () => {
    const client = new FeishuStreamClient({
      appId: "cli_app",
      appSecret: "private-app-secret",
      service: "feishu",
      connectionId: "connection-one",
      createDispatcher: (handlers) => handlers,
      createClient: (callbacks) => ({
        start: async () => {
          callbacks.logger.error("exceed_conn_limit");
        },
        close: vi.fn()
      })
    });

    await expect(client.connect()).rejects.toMatchObject({
      code: "conflict",
      options: { retryable: false, effect: "none" }
    });
    await client.close();
  });
});
