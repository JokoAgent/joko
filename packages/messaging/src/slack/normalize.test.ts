import { describe, expect, it } from "vitest";

import { normalizeSlackUpdates, type SlackNormalizationOptions } from "./normalize.js";
import type { SlackSocketUpdate } from "./model.js";

const TEAM = "T12345678";
const OWNER = "U12345678";
const OTHER = "U87654321";
const BOT = "U22222222";
const DM = "D12345678";
const CHANNEL = "C12345678";
const TS = `${Math.floor(Date.now() / 1_000)}.000123`;
const ROOT = `${Math.floor(Date.now() / 1_000) - 30}.000100`;

const options: SlackNormalizationOptions = {
  connectionId: "slack-test",
  teamId: TEAM,
  ownerUserId: OWNER,
  botUserId: BOT,
  ownerConversationId: DM,
  groupActivation: { [CHANNEL]: "mention" }
};

function envelope(eventId: string, event: unknown): SlackSocketUpdate {
  return {
    envelopeId: `envelope-${eventId}`,
    type: "events_api",
    payload: { type: "event_callback", team_id: TEAM, event_id: eventId, event },
    acceptsResponsePayload: false
  };
}

describe("Slack normalization", () => {
  it("admits only the configured owner's direct message and dedupes dual event subscriptions by message identity", () => {
    const message = { type: "message", channel: DM, channel_type: "im", user: OWNER, ts: TS, text: "hello" };
    const result = normalizeSlackUpdates([
      envelope("Ev12345678", message),
      envelope("Ev23456789", message),
      envelope("Ev34567890", { ...message, user: OTHER, ts: `${Math.floor(Date.now() / 1_000)}.000124` }),
      envelope("Ev45678901", { ...message, user: BOT, ts: `${Math.floor(Date.now() / 1_000)}.000125` })
    ], options);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      kind: "message",
      providerRequestIds: [`slack:message:${TEAM}:${DM}:${TS}`, "slack:event:Ev12345678"],
      address: { providerConversationId: `${TEAM}/${DM}`, providerThreadId: null, conversationKind: "direct" }
    });
    expect(result.ignored.map((entry) => entry.reason)).toEqual(["duplicate", "unauthorized", "service_message"]);
  });

  it("preserves an approved mention-root and its unmentioned thread continuation while rejecting unrelated roots", () => {
    const result = normalizeSlackUpdates([
      envelope("Ev12345678", { type: "app_mention", channel: CHANNEL, user: OWNER, ts: ROOT, text: `<@${BOT}> task` }),
      envelope("Ev23456789", { type: "message", channel: CHANNEL, channel_type: "channel", user: OTHER, ts: TS, thread_ts: ROOT, text: "follow up" }),
      envelope("Ev34567890", { type: "message", channel: CHANNEL, user: OTHER, ts: `${Math.floor(Date.now() / 1_000)}.000126`, text: "unrelated root" })
    ], options);
    expect(result.events).toHaveLength(2);
    expect(result.events[0]).toMatchObject({ kind: "message", text: "task", ambient: false, address: { providerThreadId: ROOT } });
    expect(result.events[1]).toMatchObject({ kind: "message", text: "follow up", ambient: true, address: { providerThreadId: ROOT } });
    expect(result.ignored[0]?.reason).toBe("unaddressed");
    expect(result.groupObservations).toHaveLength(3);
  });

  it("extracts files without trusting private URLs or oversized metadata", () => {
    const result = normalizeSlackUpdates([envelope("Ev12345678", {
      type: "message", channel: DM, user: OWNER, ts: TS, subtype: "file_share", text: "",
      files: [
        { id: "F12345678", name: "photo.png", mimetype: "image/png", size: 12, url_private: "http://127.0.0.1/secret" },
        { id: "F87654321", name: "huge.bin", size: 51 * 1024 * 1024 }
      ]
    })], options);
    expect(result.events[0]).toMatchObject({
      kind: "message",
      attachments: [{ providerFileId: `${TEAM}/F12345678`, kind: "image", fileName: "photo.png", byteLength: 12 }],
      unsupported: [{ code: "file_too_large" }]
    });
  });

  it("accepts only an exact owner button action in the same team and channel", () => {
    const interaction = (user: string, actionId: string, value: string) => ({
      type: "block_actions", team: { id: TEAM }, user: { id: user }, channel: { id: CHANNEL },
      message: { ts: TS, thread_ts: ROOT },
      actions: [{ action_id: actionId, value, action_ts: TS }]
    });
    const updates: SlackSocketUpdate[] = [
      { envelopeId: "action-1", type: "interactive", payload: interaction(OWNER, "allow_1", "allow_1"), acceptsResponsePayload: true },
      { envelopeId: "action-container-thread", type: "interactive", payload: {
        ...interaction(OWNER, "allow_2", "allow_2"),
        container: { thread_ts: ROOT },
        message: { ts: TS },
        actions: [{ action_id: "allow_2", value: "allow_2", action_ts: TS }]
      }, acceptsResponsePayload: true },
      { envelopeId: "action-2", type: "interactive", payload: interaction(OTHER, "allow_1", "allow_1"), acceptsResponsePayload: true },
      { envelopeId: "action-3", type: "interactive", payload: interaction(OWNER, "allow_1", "spoof"), acceptsResponsePayload: true }
    ];
    const result = normalizeSlackUpdates(updates, options);
    expect(result.events).toHaveLength(2);
    expect(result.events[0]).toMatchObject({ kind: "interaction", actionValue: "allow_1", messageId: TS, address: { providerThreadId: ROOT } });
    expect(result.events[1]).toMatchObject({ kind: "interaction", actionValue: "allow_2", messageId: TS, address: { providerThreadId: ROOT } });
    expect(result.ignored.map((entry) => entry.reason)).toEqual(["unauthorized", "invalid"]);
  });

  it("maps only a registered /joko command in the owner DM, never a channel slash command", () => {
    const make = (channelId: string, userId: string, envelopeId: string): SlackSocketUpdate => ({
      envelopeId,
      type: "slash_commands",
      payload: { command: "/joko", text: "new", team_id: TEAM, channel_id: channelId, user_id: userId, response_url: "https://hooks.slack.com/secret" },
      acceptsResponsePayload: true
    });
    const result = normalizeSlackUpdates([
      make(DM, OWNER, "slash-1"),
      make(CHANNEL, OWNER, "slash-2"),
      make(DM, OTHER, "slash-3")
    ], options);
    expect(result.events).toMatchObject([{
      kind: "message", providerRequestIds: ["slack:command:slash-1"], messageId: "slack:command:slash-1", text: "/new",
      address: { providerConversationId: `${TEAM}/${DM}`, providerThreadId: null }
    }]);
    expect(JSON.stringify(result)).not.toContain("hooks.slack.com");
    expect(result.ignored.map((entry) => entry.reason)).toEqual(["unauthorized", "unauthorized"]);
  });
});
