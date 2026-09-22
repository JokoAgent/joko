import { describe, expect, it } from "vitest";

import { normalizeDingTalkUpdates, type DingTalkNormalizationOptions } from "./normalize.js";

const NOW = Date.UTC(2026, 8, 22, 12, 0, 0);
const APP_KEY = "ding-app-key";

describe("normalizeDingTalkUpdates", () => {
  it("lets the first direct sender claim ownership and rejects later strangers", () => {
    const result = normalizeDingTalkUpdates([
      callback("cb-1", message({ messageId: "m-1", senderId: "owner-1", text: "hello" })),
      callback("cb-2", message({ messageId: "m-2", senderId: "stranger-1", text: "secret please" }))
    ], options());

    expect(result.ownerClaimProviderUserId).toBe("owner-1");
    expect(result.events).toEqual([
      expect.objectContaining({
        kind: "message",
        text: "hello",
        speaker: expect.objectContaining({ providerUserId: "owner-1", isOwner: true }),
        address: expect.objectContaining({ providerConversationId: "owner-1", conversationKind: "direct" })
      })
    ]);
    expect(result.ignored).toContainEqual(expect.objectContaining({
      providerRequestId: "dingtalk:callback:cb-2",
      reason: "unauthorized",
      providerUserId: "stranger-1"
    }));
    expect(JSON.stringify(result.ignored)).not.toContain("secret please");
  });

  it("requires an explicit group rule and preserves unmentioned owner text as an interaction candidate", () => {
    const result = normalizeDingTalkUpdates([
      callback("cb-disabled", message({
        conversationId: "group-disabled",
        conversationType: "2",
        messageId: "m-disabled",
        senderId: "owner-1",
        text: "ignored"
      })),
      callback("cb-mentioned", message({
        conversationId: "group-mentioned",
        conversationType: "2",
        messageId: "m-mentioned",
        senderId: "guest-1",
        text: "please help",
        mentioned: true
      })),
      callback("cb-reply", message({
        conversationId: "group-mentioned",
        conversationType: "2",
        messageId: "m-reply",
        senderId: "owner-1",
        text: "2"
      })),
      callback("cb-ambient", message({
        conversationId: "group-always",
        conversationType: "2",
        messageId: "m-ambient",
        senderId: "guest-1",
        text: "ambient"
      }))
    ], options({
      ownerUserId: "owner-1",
      groupActivation: { "group-mentioned": "mention", "group-always": "always" }
    }));

    expect(result.events).toEqual([
      expect.objectContaining({ messageId: "m-mentioned", ambient: false }),
      expect.objectContaining({ messageId: "m-ambient", ambient: true })
    ]);
    expect(result.interactionReplyCandidates).toEqual([
      expect.objectContaining({ messageId: "m-reply", text: "2", speaker: expect.objectContaining({ isOwner: true }) })
    ]);
    expect(result.groupObservations).toHaveLength(3);
    expect(result.ignored).toContainEqual(expect.objectContaining({
      providerRequestId: "dingtalk:callback:cb-disabled",
      reason: "unsupported_chat"
    }));
  });

  it("normalizes text, image, file, rich text, and audio recognition without persisting download codes", () => {
    const result = normalizeDingTalkUpdates([
      callback("cb-image", message({
        messageId: "m-image",
        senderId: "owner-1",
        messageType: "picture",
        content: { downloadCode: "private-image-code" }
      })),
      callback("cb-file", message({
        messageId: "m-file",
        senderId: "owner-1",
        messageType: "file",
        content: {
          downloadCode: "private-file-code",
          fileName: "report.pdf",
          fileType: "application/pdf",
          fileSize: 123
        }
      })),
      callback("cb-rich", message({
        messageId: "m-rich",
        senderId: "owner-1",
        messageType: "richText",
        content: { richText: [{ text: "caption" }, { type: "picture", downloadCode: "private-rich-code" }] }
      })),
      callback("cb-audio", message({
        messageId: "m-audio",
        senderId: "owner-1",
        messageType: "audio",
        recognition: "spoken request"
      }))
    ], options({ ownerUserId: "owner-1" }));

    expect(result.events).toEqual([
      expect.objectContaining({ attachments: [expect.objectContaining({ kind: "image" })] }),
      expect.objectContaining({ attachments: [expect.objectContaining({ kind: "file", fileName: "report.pdf", byteLength: 123 })] }),
      expect.objectContaining({ text: "caption", attachments: [expect.objectContaining({ kind: "image" })] }),
      expect.objectContaining({ text: "spoken request" })
    ]);
    expect(JSON.stringify(result)).not.toContain("private-image-code");
    expect(JSON.stringify(result)).not.toContain("private-file-code");
    expect(JSON.stringify(result)).not.toContain("private-rich-code");
  });

  it("rejects oversized download capabilities instead of truncating them", () => {
    const result = normalizeDingTalkUpdates([
      callback("cb-large", message({
        messageId: "m-large",
        senderId: "owner-1",
        messageType: "picture",
        content: { downloadCode: "x".repeat(4_097) }
      }))
    ], options({ ownerUserId: "owner-1" }));

    expect(result.events).toEqual([
      expect.objectContaining({
        attachments: [],
        unsupported: [{ code: "picture", label: "DingTalk image download information is unavailable." }]
      })
    ]);
  });
});

function options(overrides: Partial<DingTalkNormalizationOptions> = {}): DingTalkNormalizationOptions {
  return {
    connectionId: "ding-connection",
    appKey: APP_KEY,
    ownerUserId: null,
    groupActivation: {},
    now: () => NOW,
    ...overrides
  };
}

function callback(callbackMessageId: string, payload: unknown) {
  return { callbackMessageId, payload };
}

function message(input: {
  readonly conversationId?: string;
  readonly conversationType?: "1" | "2";
  readonly messageId: string;
  readonly senderId: string;
  readonly messageType?: string;
  readonly text?: string;
  readonly content?: unknown;
  readonly recognition?: string;
  readonly mentioned?: boolean;
}): Readonly<Record<string, unknown>> {
  return {
    conversationId: input.conversationId ?? `direct-${input.senderId}`,
    conversationType: input.conversationType ?? "1",
    msgId: input.messageId,
    msgtype: input.messageType ?? "text",
    robotCode: APP_KEY,
    senderStaffId: input.senderId,
    senderNick: input.senderId,
    createAt: NOW,
    ...(input.text === undefined ? {} : { text: { content: input.text } }),
    ...(input.content === undefined ? {} : { content: input.content }),
    ...(input.recognition === undefined ? {} : { recognition: input.recognition }),
    ...(input.mentioned === undefined ? {} : { isInAtList: input.mentioned })
  };
}
