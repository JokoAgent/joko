import { describe, expect, it } from "vitest";

import type { DiscordChannel, DiscordGatewayUpdate, DiscordMessage, DiscordUser } from "./model.js";
import { normalizeDiscordUpdates } from "./normalize.js";

const OWNER_ID = "111111111111111111";
const BOT_ID = "222222222222222222";
const OTHER_ID = "333333333333333333";
const DM_ID = "444444444444444444";
const GUILD_ID = "555555555555555555";
const ROOT_CHANNEL_ID = "666666666666666666";
const THREAD_ID = "777777777777777777";
const NOW = Date.UTC(2026, 8, 22, 12, 0, 0);

const owner: DiscordUser = { id: OWNER_ID, username: "owner", global_name: "Owner", bot: false };
const other: DiscordUser = { id: OTHER_ID, username: "guest", global_name: "Guest", bot: false };
const bot: DiscordUser = { id: BOT_ID, username: "joko", global_name: "Joko", bot: true };

describe("normalizeDiscordUpdates", () => {
  it("accepts only the owner DM and keeps attachment/reply identities provider-stable", () => {
    const referenced = message({
      id: snowflake(NOW - 1_000, 1),
      channelId: DM_ID,
      author: bot,
      content: "Earlier answer"
    });
    const accepted = message({
      id: snowflake(NOW, 2),
      channelId: DM_ID,
      author: owner,
      content: "Review this",
      referenced,
      attachments: [{
        id: "888888888888888888",
        filename: "report.txt",
        content_type: "text/plain",
        size: 12,
        url: "https://cdn.discordapp.com/attachments/a"
      }]
    });
    const stranger = message({
      id: snowflake(NOW, 3),
      channelId: DM_ID,
      author: other,
      content: "not authorized"
    });
    const result = normalizeDiscordUpdates([
      update(2, accepted, { id: DM_ID, type: 1 }),
      update(3, stranger, { id: DM_ID, type: 1 })
    ], options());

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      kind: "message",
      address: { conversationKind: "direct", providerConversationId: DM_ID, providerThreadId: null },
      speaker: { isOwner: true },
      replyContext: { providerMessageId: referenced.id, text: "Earlier answer", isBot: true },
      attachments: [{
        providerFileId: `${DM_ID}/${accepted.id}/888888888888888888`,
        fileName: "report.txt",
        mimeType: "text/plain"
      }]
    });
    expect(result.ignored).toContainEqual(expect.objectContaining({
      providerRequestId: `discord:message:${stranger.id}`,
      reason: "unauthorized"
    }));
  });

  it("requires explicit guild approval and maps a parent-approved thread to its own lane", () => {
    const unaddressed = message({
      id: snowflake(NOW, 4),
      channelId: THREAD_ID,
      guildId: GUILD_ID,
      author: other,
      content: "ambient context"
    });
    const addressed = message({
      id: snowflake(NOW, 5),
      channelId: THREAD_ID,
      guildId: GUILD_ID,
      author: other,
      content: `<@${BOT_ID}> please inspect`,
      mentions: [bot]
    });
    const channel: DiscordChannel = {
      id: THREAD_ID,
      type: 11,
      guild_id: GUILD_ID,
      parent_id: ROOT_CHANNEL_ID
    };
    const result = normalizeDiscordUpdates([
      update(4, unaddressed, channel),
      update(5, addressed, channel)
    ], options({ [`${GUILD_ID}/${ROOT_CHANNEL_ID}`]: "mention" }));

    expect(result.groupObservations).toHaveLength(2);
    expect(result.events).toEqual([expect.objectContaining({
      kind: "message",
      text: "please inspect",
      address: expect.objectContaining({
        providerConversationId: ROOT_CHANNEL_ID,
        providerThreadId: THREAD_ID,
        conversationKind: "channel"
      }),
      speaker: expect.objectContaining({ isOwner: false })
    })]);
    expect(result.ignored).toContainEqual(expect.objectContaining({
      providerRequestId: `discord:message:${unaddressed.id}`,
      reason: "unaddressed"
    }));

    const unapproved = normalizeDiscordUpdates([update(6, addressed, channel)], options());
    expect(unapproved.events).toHaveLength(0);
    expect(unapproved.ignored[0]?.reason).toBe("unsupported_chat");
  });

  it("admits only owner button interactions in an approved lane", () => {
    const messageId = snowflake(NOW - 500, 6);
    const base = {
      application_id: BOT_ID,
      type: 3,
      data: { component_type: 2, custom_id: "act_allow" },
      guild_id: GUILD_ID,
      channel_id: ROOT_CHANNEL_ID,
      message: message({ id: messageId, channelId: ROOT_CHANNEL_ID, guildId: GUILD_ID, author: bot, content: "Choose" })
    } as const;
    const channel: DiscordChannel = { id: ROOT_CHANNEL_ID, type: 0, guild_id: GUILD_ID };
    const updates: DiscordGatewayUpdate[] = [{
      sequence: 7,
      eventType: "INTERACTION_CREATE",
      interaction: { ...base, id: snowflake(NOW, 7), member: { user: owner } },
      channel
    }, {
      sequence: 8,
      eventType: "INTERACTION_CREATE",
      interaction: { ...base, id: snowflake(NOW, 8), member: { user: other } },
      channel
    }];
    const result = normalizeDiscordUpdates(updates, options({ [`${GUILD_ID}/${ROOT_CHANNEL_ID}`]: "always" }));

    expect(result.events).toEqual([expect.objectContaining({
      kind: "interaction",
      actionValue: "act_allow",
      messageId,
      speaker: expect.objectContaining({ isOwner: true })
    })]);
    expect(result.ignored).toContainEqual(expect.objectContaining({ reason: "unauthorized" }));
  });
});

function options(groupActivation: Readonly<Record<string, "mention" | "always" | "disabled">> = {}) {
  return {
    connectionId: "connection-1",
    ownerUserId: OWNER_ID,
    ownerConversationId: DM_ID,
    bot: { id: BOT_ID, username: "joko", displayName: "Joko" },
    groupActivation,
    now: () => NOW
  } as const;
}

function update(sequence: number, value: DiscordMessage, channel: DiscordChannel): DiscordGatewayUpdate {
  return { sequence, eventType: "MESSAGE_CREATE", message: value, channel };
}

function message(input: {
  readonly id: string;
  readonly channelId: string;
  readonly guildId?: string;
  readonly author: DiscordUser;
  readonly content: string;
  readonly mentions?: readonly DiscordUser[];
  readonly referenced?: DiscordMessage;
  readonly attachments?: DiscordMessage["attachments"];
}): DiscordMessage {
  return {
    id: input.id,
    channel_id: input.channelId,
    ...(input.guildId === undefined ? {} : { guild_id: input.guildId }),
    author: input.author,
    content: input.content,
    timestamp: new Date(NOW).toISOString(),
    ...(input.mentions === undefined ? {} : { mentions: input.mentions }),
    ...(input.referenced === undefined ? {} : { referenced_message: input.referenced }),
    ...(input.attachments === undefined ? {} : { attachments: input.attachments })
  };
}

function snowflake(timestamp: number, increment: number): string {
  return (((BigInt(timestamp) - 1_420_070_400_000n) << 22n) + BigInt(increment)).toString();
}
