import type { BaseMessage, WsFrame } from "@wecom/aibot-node-sdk";
import { describe, expect, it } from "vitest";

import { normalizeWeComUpdates } from "./normalize.js";
import type { WeComCallbackUpdate } from "./model.js";

const NOW = 1_800_000_000_000;

function update(body: BaseMessage, index: number): WeComCallbackUpdate {
  return {
    callbackId: `wecom:callback:${body.msgid}:request-${index}`,
    receivedAt: NOW,
    frame: { headers: { req_id: `request-${index}` }, body } as WsFrame<BaseMessage>
  };
}

function body(input: Partial<BaseMessage> & Pick<BaseMessage, "msgid" | "msgtype">): BaseMessage {
  const { msgid, msgtype, ...extras } = input;
  return {
    msgid,
    msgtype,
    aibotid: "bot-1",
    chattype: "single",
    from: { userid: "owner" },
    create_time: NOW,
    ...extras
  };
}

describe("WeCom normalization", () => {
  it("claims the first direct sender and only admits that owner in groups", () => {
    const result = normalizeWeComUpdates([
      update(body({ msgid: "m1", msgtype: "text", text: { content: "claim" } }), 1),
      update(body({ msgid: "m2", msgtype: "text", from: { userid: "stranger" }, text: { content: "no" } }), 2),
      update(body({ msgid: "m3", msgtype: "text", chattype: "group", chatid: "group-1", text: { content: "group" } }), 3)
    ], { connectionId: "connection-1", botId: "bot-1", ownerUserId: null, now: () => NOW });

    expect(result.ownerClaimProviderUserId).toBe("owner");
    expect(result.events.map((event) => [event.messageId, event.address.conversationKind, event.address.providerConversationId])).toEqual([
      ["m1", "direct", "owner"],
      ["m3", "group", "group-1"]
    ]);
    expect(result.ignored).toContainEqual(expect.objectContaining({ reason: "unauthorized", providerUserId: "stranger" }));
  });

  it("rejects groups before owner claim and rejects non-owner group senders afterwards", () => {
    const unclaimed = normalizeWeComUpdates([
      update(body({ msgid: "group-unclaimed", msgtype: "text", chattype: "group", chatid: "group-1", text: { content: "no owner" } }), 1)
    ], { connectionId: "connection-1", botId: "bot-1", ownerUserId: null, now: () => NOW });
    expect(unclaimed.ownerClaimProviderUserId).toBeNull();
    expect(unclaimed.events).toEqual([]);
    expect(unclaimed.ignored).toContainEqual(expect.objectContaining({ reason: "unauthorized", providerConversationId: "group-1" }));

    const nonOwner = normalizeWeComUpdates([
      update(body({
        msgid: "group-stranger",
        msgtype: "text",
        chattype: "group",
        chatid: "group-1",
        from: { userid: "stranger" },
        text: { content: "not allowed" }
      }), 2)
    ], { connectionId: "connection-1", botId: "bot-1", ownerUserId: "owner", now: () => NOW });
    expect(nonOwner.events).toEqual([]);
    expect(nonOwner.ignored).toContainEqual(expect.objectContaining({
      reason: "unauthorized",
      providerConversationId: "group-1",
      providerUserId: "stranger"
    }));
  });

  it("normalizes text, image, mixed, voice, file and video", () => {
    const result = normalizeWeComUpdates([
      update(body({ msgid: "text", msgtype: "text", text: { content: "hello" } }), 1),
      update(body({ msgid: "image", msgtype: "image", image: { url: "https://provider.invalid/image", aeskey: "a" } }), 2),
      update(body({ msgid: "mixed", msgtype: "mixed", mixed: { msg_item: [
        { msgtype: "text", text: { content: "caption" } },
        { msgtype: "image", image: { url: "https://provider.invalid/mixed", aeskey: "b" } }
      ] } }), 3),
      update(body({ msgid: "voice", msgtype: "voice", voice: { content: "speech" } }), 4),
      update(body({ msgid: "file", msgtype: "file", file: { url: "https://provider.invalid/file", aeskey: "c" } }), 5),
      update(body({ msgid: "video", msgtype: "video", video: { url: "https://provider.invalid/video", aeskey: "d" } }), 6)
    ], { connectionId: "connection-1", botId: "bot-1", ownerUserId: "owner", now: () => NOW });

    expect(result.events.map((event) => ({ id: event.messageId, text: event.text, kinds: event.attachments.map((part) => part.kind) }))).toEqual([
      { id: "text", text: "hello", kinds: [] },
      { id: "image", text: "", kinds: ["image"] },
      { id: "mixed", text: "caption", kinds: ["image"] },
      { id: "voice", text: "speech", kinds: [] },
      { id: "file", text: "", kinds: ["file"] },
      { id: "video", text: "", kinds: ["file"] }
    ]);
  });

  it("surfaces an empty voice recognition as unsupported content", () => {
    const result = normalizeWeComUpdates([
      update(body({ msgid: "voice-empty", msgtype: "voice", voice: { content: "" } }), 1)
    ], { connectionId: "connection-1", botId: "bot-1", ownerUserId: "owner", now: () => NOW });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.text).toBe("");
    expect(result.events[0]?.unsupported).toEqual([
      { code: "voice_empty", label: "WeCom voice has no text recognition result." }
    ]);
  });

  it("preserves text, voice and mixed quote context with attachment counts", () => {
    const result = normalizeWeComUpdates([
      update(body({
        msgid: "quoted-text",
        msgtype: "text",
        text: { content: "answer" },
        quote: { msgtype: "text", text: { content: "original" } }
      }), 1),
      update(body({
        msgid: "quoted-voice",
        msgtype: "text",
        text: { content: "answer" },
        quote: { msgtype: "voice", voice: { content: "spoken" } }
      }), 2),
      update(body({
        msgid: "quoted-mixed",
        msgtype: "text",
        text: { content: "answer" },
        quote: { msgtype: "mixed", mixed: { msg_item: [
          { msgtype: "text", text: { content: "caption" } },
          { msgtype: "image", image: { url: "https://provider.invalid/image" } }
        ] } }
      }), 3)
    ], { connectionId: "connection-1", botId: "bot-1", ownerUserId: "owner", now: () => NOW });

    expect(result.events.map((event) => event.replyContext)).toEqual([
      expect.objectContaining({ providerMessageId: "quoted-text", text: "original", attachmentCount: 0 }),
      expect.objectContaining({ providerMessageId: "quoted-voice", text: "spoken", attachmentCount: 0 }),
      expect.objectContaining({ providerMessageId: "quoted-mixed", text: "caption", attachmentCount: 1 })
    ]);
  });
});
