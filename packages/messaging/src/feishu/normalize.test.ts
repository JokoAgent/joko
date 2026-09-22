import { describe, expect, it } from "vitest";

import {
  feishuHistoryObservation,
  normalizeFeishuUpdates,
  type FeishuNormalizationOptions
} from "./normalize.js";
import type { FeishuCallbackUpdate, FeishuMessageEnvelope } from "./model.js";

const NOW = Date.UTC(2026, 8, 22, 12, 0, 0);

describe("normalizeFeishuUpdates", () => {
  it("lets the first direct sender claim ownership and rejects later strangers without retaining their text", () => {
    const result = normalizeFeishuUpdates([
      update(message({ messageId: "m-owner", senderOpenId: "ou_owner", text: "hello" })),
      update(message({ messageId: "m-stranger", senderOpenId: "ou_stranger", text: "private instruction" }))
    ], options());

    expect(result.ownerClaimProviderUserId).toBe("ou_owner");
    expect(result.events).toEqual([
      expect.objectContaining({
        kind: "message",
        text: "hello",
        address: expect.objectContaining({
          channel: "feishu",
          providerConversationId: "ou_owner",
          conversationKind: "direct"
        }),
        speaker: expect.objectContaining({ providerUserId: "ou_owner", isOwner: true })
      })
    ]);
    expect(result.ignored).toContainEqual(expect.objectContaining({
      providerRequestId: "message:m-stranger",
      reason: "unauthorized",
      providerUserId: "ou_stranger"
    }));
    expect(JSON.stringify(result.ignored)).not.toContain("private instruction");
  });

  it("requires an explicit group rule, only lets the owner trigger, and preserves topic-scoped observations", () => {
    const result = normalizeFeishuUpdates([
      update(message({
        messageId: "m-guest",
        chatId: "oc_allowed",
        chatType: "group",
        senderOpenId: "ou_guest",
        threadId: "omt_topic",
        text: "context from guest"
      })),
      update(message({
        messageId: "m-owner-unmentioned",
        chatId: "oc_allowed",
        chatType: "group",
        senderOpenId: "ou_owner",
        threadId: "omt_topic",
        text: "not addressed"
      })),
      update(message({
        messageId: "m-owner-mentioned",
        chatId: "oc_allowed",
        chatType: "group",
        senderOpenId: "ou_owner",
        threadId: "omt_topic",
        text: "@_user_1 do it",
        mentions: [{ key: "@_user_1", openId: "ou_bot", name: "Joko" }]
      })),
      update(message({
        messageId: "m-unlisted",
        chatId: "oc_unlisted",
        chatType: "group",
        senderOpenId: "ou_owner",
        text: "ignored"
      }))
    ], options({ ownerUserId: "ou_owner", groupActivation: { oc_allowed: "mention" } }));

    expect(result.events).toEqual([
      expect.objectContaining({
        messageId: "m-owner-mentioned",
        text: "do it",
        ambient: false,
        address: expect.objectContaining({
          providerConversationId: "oc_allowed",
          providerThreadId: "omt_topic",
          conversationKind: "group"
        })
      })
    ]);
    expect(result.groupObservations).toHaveLength(4);
    expect(result.groupObservations[0]).toMatchObject({
      messageId: "m-guest",
      text: "context from guest",
      address: { providerThreadId: "omt_topic" }
    });
    expect(result.ignored).toEqual(expect.arrayContaining([
      expect.objectContaining({ providerRequestId: "message:m-guest", reason: "unauthorized" }),
      expect.objectContaining({ providerRequestId: "message:m-owner-unmentioned", reason: "unaddressed" }),
      expect.objectContaining({ providerRequestId: "message:m-unlisted", reason: "unauthorized" })
    ]));
  });

  it("admits only owner card actions and keeps the embedded topic address", () => {
    const address = {
      channel: "lark" as const,
      connectionId: "connection-one",
      providerConversationId: "oc_group",
      providerThreadId: "omt_topic",
      conversationKind: "group" as const
    };
    const result = normalizeFeishuUpdates([
      {
        callbackId: "card:allowed",
        kind: "card_action",
        action: {
          callbackId: "card:allowed",
          messageId: "om_card",
          chatId: "oc_group",
          operatorOpenId: "ou_owner",
          actionValue: "choice:allow",
          address,
          occurredAt: NOW
        }
      },
      {
        callbackId: "card:denied",
        kind: "card_action",
        action: {
          callbackId: "card:denied",
          messageId: "om_card",
          chatId: "oc_group",
          operatorOpenId: "ou_guest",
          actionValue: "choice:deny",
          address,
          occurredAt: NOW
        }
      }
    ], options({ service: "lark", ownerUserId: "ou_owner" }));

    expect(result.events).toEqual([
      expect.objectContaining({ kind: "interaction", actionValue: "choice:allow", address })
    ]);
    expect(result.ignored).toContainEqual(expect.objectContaining({
      providerRequestId: "card:denied",
      reason: "unauthorized"
    }));
  });
});

describe("feishuHistoryObservation", () => {
  it("normalizes exact topic history without leaking attachment resource keys into the observation", () => {
    const observation = feishuHistoryObservation({
      service: "feishu",
      connectionId: "connection-one",
      ownerUserId: "ou_owner",
      message: {
        messageId: "om_history",
        chatId: "oc_group",
        threadId: "omt_topic",
        senderOpenId: "ou_guest",
        senderName: "Guest",
        senderIsBot: false,
        messageType: "file",
        content: JSON.stringify({ file_key: "private-resource-key", file_name: "context.txt" }),
        occurredAt: NOW
      }
    });

    expect(observation).toMatchObject({
      address: { providerConversationId: "oc_group", providerThreadId: "omt_topic" },
      attachmentNames: ["context.txt"]
    });
    expect(JSON.stringify(observation)).not.toContain("private-resource-key");
  });
});

function options(overrides: Partial<FeishuNormalizationOptions> = {}): FeishuNormalizationOptions {
  return {
    service: "feishu",
    connectionId: "connection-one",
    appId: "cli_app",
    botOpenId: "ou_bot",
    ownerUserId: null,
    groupActivation: {},
    now: () => NOW,
    ...overrides
  };
}

function update(value: FeishuMessageEnvelope): FeishuCallbackUpdate {
  return { callbackId: `message:${value.messageId}`, kind: "message", message: value };
}

function message(input: {
  readonly messageId: string;
  readonly chatId?: string;
  readonly chatType?: "p2p" | "group";
  readonly senderOpenId: string;
  readonly threadId?: string | null;
  readonly text: string;
  readonly mentions?: FeishuMessageEnvelope["mentions"];
}): FeishuMessageEnvelope {
  return {
    messageId: input.messageId,
    chatId: input.chatId ?? `oc_${input.senderOpenId}`,
    chatType: input.chatType ?? "p2p",
    messageType: "text",
    content: JSON.stringify({ text: input.text }),
    senderOpenId: input.senderOpenId,
    senderName: input.senderOpenId,
    senderIsBot: false,
    threadId: input.threadId ?? null,
    parentId: null,
    rootId: null,
    mentions: input.mentions ?? [],
    occurredAt: NOW
  };
}
