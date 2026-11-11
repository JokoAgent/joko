import { describe, expect, it } from "vitest";

import type { TelegramMessage, TelegramUpdate, TelegramUser } from "./model.js";
import { normalizeTelegramUpdates, type TelegramNormalizationOptions } from "./normalize.js";

const NOW = Date.UTC(2026, 8, 22, 12, 0, 0);
const OWNER = user(42, "Owner", "owner");
const STRANGER = user(99, "Guest", "guest");
const BOT = user(700, "Joko", "jokobot", true);

describe("normalizeTelegramUpdates", () => {
  it("admits only the configured owner in direct messages", () => {
    const result = normalizeTelegramUpdates([
      update(10, message({ id: 1, from: OWNER, chatId: 42, chatType: "private", text: "owner text" })),
      update(11, message({ id: 2, from: STRANGER, chatId: 99, chatType: "private", text: "secret please" }))
    ], options());

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      kind: "message",
      text: "owner text",
      speaker: { providerUserId: "42", isOwner: true },
      address: { providerConversationId: "42", conversationKind: "direct" }
    });
    expect(result.ignored).toContainEqual({
      providerRequestId: "telegram:update:11",
      reason: "unauthorized",
      providerConversationId: "99",
      providerUserId: "99"
    });
    expect(JSON.stringify(result.ignored)).not.toContain("secret please");
  });

  it("routes an addressed protected topic turn but never emits protected history", () => {
    const replied = message({
      id: 7,
      from: STRANGER,
      chatId: -1005,
      chatType: "supergroup",
      text: "protected history",
      protectedContent: true
    });
    const incoming = message({
      id: 8,
      from: STRANGER,
      chatId: -1005,
      chatType: "supergroup",
      text: "@jokobot help",
      threadId: 55,
      isTopic: true,
      protectedContent: true,
      replyTo: replied,
      entities: [{ type: "mention", offset: 0, length: 8 }]
    });

    const result = normalizeTelegramUpdates([update(12, incoming)], options());

    expect(result.events).toEqual([
      expect.objectContaining({
        kind: "message",
        text: "help",
        protectedContent: true,
        replyContext: null,
        address: expect.objectContaining({
          providerConversationId: "-1005",
          providerThreadId: "55",
          conversationKind: "group"
        }),
        speaker: expect.objectContaining({ providerUserId: "99", isOwner: false })
      })
    ]);
    expect(result.groupObservations).toEqual([]);
  });

  it("separates mention and ambient activation while keeping commands owner-only", () => {
    const base = options({ groupActivation: { "-10": "always" } });
    const ambient = update(20, message({
      id: 1,
      from: STRANGER,
      chatId: -10,
      chatType: "group",
      text: "general discussion"
    }));
    const foreignCommand = update(21, message({
      id: 2,
      from: STRANGER,
      chatId: -10,
      chatType: "group",
      text: "/stop"
    }));
    const ownerCommand = update(22, message({
      id: 3,
      from: OWNER,
      chatId: -10,
      chatType: "group",
      text: "/stop"
    }));

    const result = normalizeTelegramUpdates([ambient, foreignCommand, ownerCommand], base);

    expect(result.events).toEqual([
      expect.objectContaining({ kind: "message", text: "general discussion", ambient: true }),
      expect.objectContaining({ kind: "message", text: "/stop", ambient: false })
    ]);
    expect(result.ignored).toContainEqual(expect.objectContaining({
      providerRequestId: "telegram:update:21",
      reason: "unauthorized"
    }));
    expect(result.groupObservations).toHaveLength(3);
  });

  it("keeps explicit empty summons and checks text and caption mentions against the bot identity", () => {
    const group = (id: number, text?: string) => message({ id, from: STRANGER, chatId: -10, chatType: "group",
      ...(text === undefined ? {} : { text }) });
    const pure = update(70, { ...group(70, "@jokobot"), entities: [{ type: "mention", offset: 0, length: 8 }] });
    const named = update(71, { ...group(71, "😺 Joko 你好"),
      entities: [{ type: "text_mention", offset: 3, length: 4, user: BOT }] });
    const other = update(72, { ...group(72, "Joko 你好"),
      entities: [{ type: "text_mention", offset: 0, length: 4, user: user(701, "Joko", "other_bot", true) }] });
    const manual = update(73, group(73, "@Joko"));
    const bare = update(74, group(74, "Joko 今天请假了"));
    const photo = update(75, { ...message({ id: 75, from: STRANGER, chatId: -10, chatType: "group", photoId: "caption-photo" }),
      caption: "😀 Joko 看图", caption_entities: [{ type: "text_mention", offset: 3, length: 4, user: BOT }] });
    const reply = update(76, { ...group(76), reply_to_message: message({ id: 66, from: BOT, chatId: -10, chatType: "group", text: "Earlier reply" }) });
    const malformed = update(77, { ...group(77, "Joko"),
      entities: [{ type: "text_mention", offset: 1, length: 4, user: BOT }] });
    const result = normalizeTelegramUpdates([pure, named, other, manual, bare, photo, reply, malformed], options());
    expect(result.events).toEqual([
      expect.objectContaining({ messageId: "70", text: "", ambient: false }),
      expect.objectContaining({ messageId: "71", text: "😺 你好", ambient: false }),
      expect.objectContaining({ messageId: "73", text: "", ambient: false }),
      expect.objectContaining({ messageId: "75", text: "😀 看图", ambient: false, attachments: [expect.objectContaining({ kind: "image" })] }),
      expect.objectContaining({ messageId: "76", text: "", ambient: false, replyContext: expect.objectContaining({ text: "Earlier reply" }) })
    ]);
    expect(result.ignored.map(({ providerRequestId, reason }) => [providerRequestId, reason])).toEqual(
      [72, 74, 77].map(id => [`telegram:update:${id}`, "unaddressed"]));
    expect(normalizeTelegramUpdates([pure], options({ groupActivation: { "-10": "disabled" } })).events).toEqual([]);
    expect(normalizeTelegramUpdates([pure, bare], options({ groupActivation: { "-10": "always" } })).events).toEqual([
      expect.objectContaining({ messageId: "70", text: "", ambient: false }),
      expect.objectContaining({ messageId: "74", text: "Joko 今天请假了", ambient: true })
    ]);
  });

  it("folds one media group into one event and flags oversize items", () => {
    const first = message({
      id: 30,
      from: OWNER,
      chatId: 42,
      chatType: "private",
      text: "album",
      mediaGroupId: "a",
      photoId: "photo-1"
    });
    const second = message({
      id: 31,
      from: OWNER,
      chatId: 42,
      chatType: "private",
      mediaGroupId: "a",
      photoId: "photo-2"
    });
    const third = message({
      id: 32,
      from: OWNER,
      chatId: 42,
      chatType: "private",
      mediaGroupId: "a",
      document: {
        file_id: "too-large",
        file_unique_id: "u3",
        file_name: "large.bin",
        file_size: (20 * 1024 * 1024) + 1
      }
    });

    const result = normalizeTelegramUpdates([update(30, first), update(31, second), update(32, third)], options());

    expect(result.events).toEqual([
      expect.objectContaining({
        providerRequestIds: ["telegram:update:30", "telegram:update:31", "telegram:update:32"],
        text: "album",
        attachments: [
          expect.objectContaining({ providerFileId: "photo-1", kind: "image" }),
          expect.objectContaining({ providerFileId: "photo-2", kind: "image" })
        ],
        unsupported: [{ code: "oversize", label: "File exceeds Telegram's download limit." }]
      })
    ]);
  });

  it("admits only owner interactions and keeps callback values opaque", () => {
    const card = message({ id: 40, from: BOT, chatId: 42, chatType: "private", text: "choose" });
    const result = normalizeTelegramUpdates([
      { update_id: 40, callback_query: { id: "cb-owner", from: OWNER, message: card, data: "claim:abc" } },
      { update_id: 41, callback_query: { id: "cb-other", from: STRANGER, message: card, data: "claim:abc" } }
    ], options());

    expect(result.events).toEqual([
      expect.objectContaining({
        kind: "interaction",
        interactionId: "cb-owner",
        actionValue: "claim:abc",
        speaker: expect.objectContaining({ isOwner: true })
      })
    ]);
    expect(result.ignored).toContainEqual(expect.objectContaining({
      providerRequestId: "telegram:update:41",
      reason: "unauthorized"
    }));
  });

  it("preserves the exact quoted message identity for reply-routed interactions", () => {
    const card = message({ id: 40, from: BOT, chatId: 42, chatType: "private", text: "answer these fields" });
    const reply = message({
      id: 41,
      from: OWNER,
      chatId: 42,
      chatType: "private",
      text: "name: Alice",
      replyTo: card
    });

    const result = normalizeTelegramUpdates([update(42, reply)], options());

    expect(result.events).toEqual([
      expect.objectContaining({
        kind: "message",
        text: "name: Alice",
        replyContext: expect.objectContaining({
          providerMessageId: "40",
          author: "Joko",
          isBot: true
        })
      })
    ]);
  });
});

function options(overrides: Partial<TelegramNormalizationOptions> = {}): TelegramNormalizationOptions {
  return {
    connectionId: "connection-1",
    ownerUserId: "42",
    bot: { id: BOT.id, username: BOT.username ?? "", displayName: BOT.first_name },
    now: () => NOW,
    ...overrides
  };
}

function user(id: number, firstName: string, username: string, isBot = false): TelegramUser {
  return { id, is_bot: isBot, first_name: firstName, username };
}

function update(updateId: number, value: TelegramMessage): TelegramUpdate {
  return { update_id: updateId, message: value };
}

function message(input: {
  readonly id: number;
  readonly from: TelegramUser;
  readonly chatId: number;
  readonly chatType: "private" | "group" | "supergroup" | "channel";
  readonly text?: string;
  readonly threadId?: number;
  readonly isTopic?: boolean;
  readonly protectedContent?: boolean;
  readonly replyTo?: TelegramMessage;
  readonly entities?: TelegramMessage["entities"];
  readonly mediaGroupId?: string;
  readonly photoId?: string;
  readonly document?: TelegramMessage["document"];
}): TelegramMessage {
  return {
    message_id: input.id,
    from: input.from,
    chat: { id: input.chatId, type: input.chatType },
    date: Math.floor(NOW / 1_000),
    ...(input.text === undefined ? {} : { text: input.text }),
    ...(input.threadId === undefined ? {} : { message_thread_id: input.threadId }),
    ...(input.isTopic === undefined ? {} : { is_topic_message: input.isTopic }),
    ...(input.protectedContent === undefined ? {} : { has_protected_content: input.protectedContent }),
    ...(input.replyTo === undefined ? {} : { reply_to_message: input.replyTo }),
    ...(input.entities === undefined ? {} : { entities: input.entities }),
    ...(input.mediaGroupId === undefined ? {} : { media_group_id: input.mediaGroupId }),
    ...(input.photoId === undefined ? {} : {
      photo: [{
        file_id: input.photoId,
        file_unique_id: `${input.photoId}-unique`,
        width: 800,
        height: 600,
        file_size: 1_024
      }]
    }),
    ...(input.document === undefined ? {} : { document: input.document })
  };
}
