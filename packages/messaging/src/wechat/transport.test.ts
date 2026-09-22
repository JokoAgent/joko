import { createCipheriv } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import type { MessagingAddress } from "../types.js";
import type { WeChatFetch } from "./api.js";
import { WeChatTransport } from "./transport.js";

const credentials = { token: "credential-secret", botId: "bot-1", userId: "connected-owner", baseUrl: "https://ilinkai.weixin.qq.com/" };
const address: MessagingAddress = { channel: "wechat", connectionId: "conn-1", providerConversationId: "peer-1", providerThreadId: null, conversationKind: "direct" };

function encrypt(bytes: Uint8Array, key: Uint8Array): Uint8Array {
  const cipher = createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(bytes), cipher.final()]);
}

describe("WeChat transport effects and recovery", () => {
  it("caches probe poll, keeps private context out of events, decrypts an adopted image, and sends each effect once", async () => {
    const key = Buffer.alloc(16, 4);
    const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 1, 2, 3]);
    const ciphertext = encrypt(image, key);
    const inbound = {
      message_type: 1, client_id: "incoming-1", from_user_id: "peer-1", to_user_id: "bot-1",
      create_time_ms: 2_000_000, context_token: "private-context",
      item_list: [
        { type: 1, text_item: { text: "hello" } },
        { type: 2, image_item: { media: { full_url: "https://novac2c.cdn.weixin.qq.com/c2c/download?id=1", aes_key: key.toString("base64") }, mid_size: ciphertext.byteLength } }
      ]
    };
    const sentBodies: Record<string, unknown>[] = [];
    const calls: string[] = [];
    const fetch: WeChatFetch = vi.fn(async (input, init) => {
      const url = new URL(String(input));
      calls.push(url.pathname);
      if (url.pathname.endsWith("notifystart") || url.pathname.endsWith("notifystop")) return new Response(JSON.stringify({ ret: 0 }));
      if (url.pathname.endsWith("getupdates")) return new Response(JSON.stringify({ ret: 0, get_updates_buf: "cursor-next", msgs: [inbound] }));
      if (url.pathname === "/c2c/download") return new Response(Buffer.from(ciphertext));
      if (url.pathname.endsWith("sendmessage")) { sentBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>); return new Response(JSON.stringify({ ret: 0 })); }
      if (url.pathname.endsWith("getuploadurl")) return new Response(JSON.stringify({ ret: 0, upload_param: "upload-ref" }));
      if (url.pathname === "/c2c/upload") return new Response(null, { status: 200, headers: { "x-encrypted-param": "download-ref" } });
      if (url.pathname.endsWith("getconfig")) return new Response(JSON.stringify({ ret: 0, typing_ticket: "typing-private" }));
      if (url.pathname.endsWith("sendtyping")) return new Response(JSON.stringify({ ret: 0 }));
      throw new Error("unexpected fixture path");
    });
    const transport = new WeChatTransport({ connectionId: "conn-1", generation: 2, credentials, initialCursor: "cursor-old", now: () => 2_000_000_000, fetch });
    expect(await transport.probe()).toMatchObject({ providerAccountId: "bot-1", generation: 2 });
    const first = await transport.poll({ cursor: "cursor-old" });
    expect(first).toMatchObject({ nextCursor: "cursor-next", updates: [inbound] });
    expect(calls.filter((path) => path.endsWith("getupdates"))).toHaveLength(1);
    const normalized = transport.normalize(first.updates);
    expect(normalized.events).toHaveLength(1);
    expect(normalized.events[0]).toMatchObject({ speaker: { providerUserId: "peer-1", isOwner: false }, attachments: [{ mimeType: "image/*" }] });
    expect(normalized.privateContexts).toEqual([{ messageId: "client:incoming-1", providerConversationId: "peer-1", contextToken: "private-context" }]);
    expect(JSON.stringify(normalized.events)).not.toContain("private-context");
    const downloaded = await transport.downloadAttachment(normalized.events[0]!.kind === "message" ? normalized.events[0]!.attachments[0]! : null!);
    expect(downloaded).toMatchObject({ mimeType: "image/png", fileName: "wechat-image.png" });
    expect(Buffer.from(downloaded.bytes)).toEqual(image);

    const context = { contextToken: "private-context", clientId: "delivery-1" };
    await transport.sendTextPart({ address, text: "##### Header\nhello *中文*", context });
    await transport.sendInteractionCard({ address, text: "Choose", buttons: [{ label: "Allow", actionValue: "yes" }], context: { ...context, clientId: "interaction-1" } });
    await transport.sendAttachments({ address, context: { ...context, clientId: "media-1" }, attachments: [{ kind: "image", bytes: image, fileName: "a.png", mimeType: "image/png" }] });
    await transport.sendTyping(address, undefined, "private-context");
    expect(sentBodies).toHaveLength(3);
    const messages = sentBodies.map((body) => body["msg"] as Record<string, unknown>);
    expect(messages.map((message) => message["client_id"])).toEqual(["delivery-1", "interaction-1", "media-1"]);
    expect(JSON.stringify(messages[0])).toContain("Header\\nhello 中文");
    expect(JSON.stringify(messages[1])).toContain("1. Allow");
    expect(JSON.stringify(messages[2])).toContain("download-ref");
    expect(calls.filter((path) => path.endsWith("sendmessage"))).toHaveLength(3);
    await transport.clearInteractionCard({ address, messageId: "interaction-1" });
    await transport.setReaction({ address, messageId: "incoming-1", emoji: "✅" });
    expect(calls.filter((path) => path.endsWith("sendmessage"))).toHaveLength(3);
    await transport.close();
    await expect(transport.poll({ cursor: "cursor-next" })).rejects.toMatchObject({ code: "cancelled" });
    expect(calls.filter((path) => path.endsWith("notifystop"))).toHaveLength(1);
  });

  it("maps auth loss and malformed poll without silently advancing cursor or replaying unknown sends", async () => {
    const authLoss = new WeChatTransport({
      connectionId: "conn-1", generation: 1, credentials,
      fetch: async (input) => new Response(JSON.stringify(new URL(String(input)).pathname.endsWith("getupdates") ? { ret: 0, errcode: -14 } : { ret: 0 }))
    });
    await expect(authLoss.probe()).rejects.toMatchObject({ code: "invalid_credential", options: { retryable: false } });
    const bad = new WeChatTransport({
      connectionId: "conn-1", generation: 1, credentials,
      fetch: async (input) => new Response(JSON.stringify(new URL(String(input)).pathname.endsWith("getupdates") ? { ret: 0, msgs: [{}], get_updates_buf: "next" } : { ret: 0 }))
    });
    await bad.probe();
    const batch = await bad.poll({ cursor: null });
    expect(batch.nextCursor).toBe("next");
    expect(bad.normalize(batch.updates).events).toEqual([]);
    await expect(bad.sendTextPart({ address, text: "text" })).rejects.toMatchObject({ code: "invalid_input" });
    await bad.close();
  });
});
