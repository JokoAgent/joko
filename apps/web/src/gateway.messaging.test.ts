import { create } from "@bufbuild/protobuf";
import type { Transport } from "@connectrpc/connect";
import {
  DingTalkGroupActivation,
  DiscordEmojiReactions,
  DiscordGroupActivation,
  DiscordReplyQuoteMode,
  FeishuEmojiReactions,
  FeishuGroupActivation,
  FeishuReplyQuoteMode,
  MessagingChannel,
  MessagingConnectionRuntimeStatus,
  MessagingConnectionTestFailure,
  PermissionMode,
  SlackEmojiReactions,
  SlackGroupActivation,
  TelegramEmojiReactions,
  TelegramGroupActivation,
  TelegramReplyQuoteMode,
  WeChatAuthorizationStatus
} from "@joko/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createOrchestratorGateway } from "./gateway.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Messaging gateway", () => {
  it("maps the complete settings surface and sends bot tokens only through the fenced upload ticket", async () => {
    const fixture = await mount();
    const uploaded: string[] = [];
    const buffers: Uint8Array[] = [];
    const fetch = vi.fn(async (_url: unknown, init: RequestInit) => {
      uploaded.push(new TextDecoder().decode(init.body as Uint8Array));
      buffers.push(init.body as Uint8Array);
      return new Response(undefined, { status: 204 });
    });
    vi.stubGlobal("fetch", fetch);
    const signal = new AbortController().signal;

    await expect(fixture.gateway.getMessagingSettings(signal)).resolves.toEqual({
      connections: [
        expect.objectContaining({
          id: "telegram-one",
          channel: "telegram",
          generation: 3n,
          revision: 7n,
          runtimeStatus: "connected",
          credentialConfigured: true,
          telegramConfiguration: {
            emojiReactions: "minimal",
            replyQuoteDm: "off",
            replyQuoteGroup: "first",
            groupActivation: { "-100": "mention", "-200": "always" }
          },
          lastConnectedAt: 4_500
        }),
        expect.objectContaining({
          id: "discord-one",
          channel: "discord",
          generation: 4n,
          revision: 8n,
          runtimeStatus: "connected",
          credentialConfigured: true,
          discordConfiguration: {
            lifecycleAnnouncements: true,
            emojiReactions: "expressive",
            replyQuoteDm: "first",
            replyQuoteGroup: "all",
            groupActivation: {
              "123456789012345678/234567890123456789": "mention",
              "123456789012345678/345678901234567890": "always"
            }
          },
          lastConnectedAt: 5_250
        }),
        expect.objectContaining({
          id: "dingtalk-one",
          channel: "dingtalk",
          generation: 5n,
          revision: 9n,
          runtimeStatus: "connected",
          credentialConfigured: true,
          dingtalkConfiguration: {
            appKey: "ding-app-key",
            groupActivation: {
              "cid-group-one": "mention",
              "cid-group-two": "always"
            }
          },
          lastConnectedAt: 6_125
        }),
        expect.objectContaining({
          id: "feishu-one",
          channel: "feishu",
          generation: 6n,
          revision: 10n,
          runtimeStatus: "connected",
          credentialConfigured: true,
          feishuConfiguration: {
            appId: "cli_feishu",
            lifecycleAnnouncements: true,
            emojiReactions: "minimal",
            replyQuoteDm: "off",
            replyQuoteGroup: "first",
            groupActivation: { oc_primary: "mention", oc_muted: "disabled" },
            groupPermissionMode: "bypassPermissions"
          },
          lastConnectedAt: 7_250
        }),
        expect.objectContaining({
          id: "lark-one",
          channel: "lark",
          feishuConfiguration: expect.objectContaining({ appId: "cli_lark" })
        }),
        expect.objectContaining({
          id: "wecom-one",
          channel: "wecom",
          generation: 7n,
          revision: 11n,
          runtimeStatus: "connected",
          credentialConfigured: true,
          ownerProviderUserId: "wecom-owner",
          wecomConfiguration: { botId: "bot_wecom" },
          lastConnectedAt: 8_500
        })
      ],
      routes: [expect.objectContaining({
        scopeKey: "global",
        targetId: "target-one",
        backendId: "backend-one",
        permissionMode: "ask",
        revision: 5n
      })],
      channels: [
        { channel: "telegram", available: true },
        { channel: "discord", available: true },
        { channel: "dingtalk", available: true },
        { channel: "feishu", available: true },
        { channel: "lark", available: true },
        { channel: "wecom", available: true },
        { channel: "wechat", available: false, reason: "not implemented" },
        { channel: "slack", available: false, reason: "not implemented" }
      ]
    });

    const configuration = {
      emojiReactions: "expressive" as const,
      replyQuoteDm: "first" as const,
      replyQuoteGroup: "all" as const,
      groupActivation: { "-300": "disabled" as const }
    };
    await fixture.gateway.createTelegramMessagingConnection("42", configuration, signal);
    const discordConfiguration = {
      lifecycleAnnouncements: false,
      emojiReactions: "minimal" as const,
      replyQuoteDm: "off" as const,
      replyQuoteGroup: "first" as const,
      groupActivation: { "456789012345678901/567890123456789012": "disabled" as const }
    };
    await fixture.gateway.createDiscordMessagingConnection("987654321098765432", discordConfiguration, signal);
    const dingtalkConfiguration = {
      appKey: "ding-new-app-key",
      groupActivation: { "cid-disabled": "disabled" as const }
    };
    await fixture.gateway.createDingTalkMessagingConnection(dingtalkConfiguration, signal);
    const feishuConfiguration = {
      appId: "cli_new",
      lifecycleAnnouncements: false,
      emojiReactions: "expressive" as const,
      replyQuoteDm: "first" as const,
      replyQuoteGroup: "all" as const,
      groupActivation: { oc_new: "always" as const },
      groupPermissionMode: "ask" as const
    };
    await fixture.gateway.createFeishuMessagingConnection("lark", feishuConfiguration, signal);
    await fixture.gateway.createWeComMessagingConnection({ botId: " bot_new " }, signal);
    await fixture.gateway.saveMessagingCredential("telegram-one", 7n, 3n, "telegram-test-token", true, signal);
    await fixture.gateway.clearMessagingCredential("telegram-one", 7n, 3n, signal);
    await fixture.gateway.setMessagingConnectionEnabled("telegram-one", 7n, 3n, false, signal);
    await fixture.gateway.updateTelegramMessagingConfiguration("telegram-one", 7n, 3n, "84", configuration, signal);
    await fixture.gateway.updateDiscordMessagingConfiguration(
      "discord-one",
      8n,
      4n,
      "876543210987654321",
      discordConfiguration,
      signal
    );
    await fixture.gateway.updateDingTalkMessagingConfiguration(
      "dingtalk-one",
      9n,
      5n,
      dingtalkConfiguration,
      signal
    );
    await fixture.gateway.updateFeishuMessagingConfiguration(
      "feishu-one",
      10n,
      6n,
      feishuConfiguration,
      signal
    );
    await fixture.gateway.updateWeComMessagingConfiguration(
      "wecom-one",
      11n,
      7n,
      { botId: "bot_updated" },
      signal
    );
    await expect(fixture.gateway.testMessagingConnection("telegram-one", signal)).resolves.toEqual({
      ok: true,
      providerAccountId: "9001",
      displayName: "Joko Bot",
      username: "joko_test_bot"
    });
    await expect(fixture.gateway.testMessagingConnection("telegram-one", signal)).resolves.toEqual({
      ok: false,
      failure: "connectionFailed"
    });
    await fixture.gateway.putMessagingRoute({
      connectionId: "telegram-one",
      expectedRevision: 5n,
      targetId: "target-two",
      providerId: "provider-one",
      modelId: "model-one",
      effort: "high",
      fastMode: true,
      permissionMode: "bypassPermissions",
      planMode: true
    }, signal);

    expect(uploaded).toEqual(["telegram-test-token"]);
    expect(buffers).toHaveLength(1);
    expect(buffers[0]!.every((byte) => byte === 0)).toBe(true);
    expect(fetch).toHaveBeenCalledWith(
      "https://service.example/v1/credential-uploads/messaging-ticket",
      expect.objectContaining({
        method: "PUT",
        signal: expect.any(AbortSignal),
        headers: { authorization: "Bearer fixture-auth", "content-type": "application/octet-stream" }
      })
    );

    const byMethod = (name: string) => fixture.requests.find((entry) => entry.method === name)?.input;
    expect(byMethod("createMessagingConnection")).toMatchObject({
      channel: MessagingChannel.TELEGRAM,
      ownerProviderUserId: "42",
      telegramConfiguration: {
        emojiReactions: TelegramEmojiReactions.EXPRESSIVE,
        replyQuoteDm: TelegramReplyQuoteMode.FIRST,
        replyQuoteGroup: TelegramReplyQuoteMode.ALL,
        groupActivationRules: [{
          chatId: "-300",
          activation: TelegramGroupActivation.DISABLED
        }]
      }
    });
    expect(fixture.requests.find((entry) => entry.method === "createMessagingConnection"
      && entry.input.channel === MessagingChannel.DISCORD)?.input).toMatchObject({
      channel: MessagingChannel.DISCORD,
      ownerProviderUserId: "987654321098765432",
      discordConfiguration: {
        lifecycleAnnouncements: false,
        emojiReactions: DiscordEmojiReactions.MINIMAL,
        replyQuoteDm: DiscordReplyQuoteMode.OFF,
        replyQuoteGroup: DiscordReplyQuoteMode.FIRST,
        groupActivationRules: [{
          guildId: "456789012345678901",
          channelId: "567890123456789012",
          activation: DiscordGroupActivation.DISABLED
        }]
      }
    });
    const dingtalkCreate = fixture.requests.find((entry) => entry.method === "createMessagingConnection"
      && entry.input.channel === MessagingChannel.DINGTALK)?.input;
    expect(dingtalkCreate).toMatchObject({
      channel: MessagingChannel.DINGTALK,
      dingtalkConfiguration: {
        appKey: "ding-new-app-key",
        groupActivationRules: [{
          conversationId: "cid-disabled",
          activation: DingTalkGroupActivation.DISABLED
        }]
      }
    });
    expect(dingtalkCreate.ownerProviderUserId).toBeUndefined();
    const larkCreate = fixture.requests.find((entry) => entry.method === "createMessagingConnection"
      && entry.input.channel === MessagingChannel.LARK)?.input;
    expect(larkCreate).toMatchObject({
      channel: MessagingChannel.LARK,
      feishuConfiguration: {
        appId: "cli_new",
        lifecycleAnnouncements: false,
        emojiReactions: FeishuEmojiReactions.EXPRESSIVE,
        replyQuoteDm: FeishuReplyQuoteMode.FIRST,
        replyQuoteGroup: FeishuReplyQuoteMode.ALL,
        groupActivationRules: [{ chatId: "oc_new", activation: FeishuGroupActivation.ALWAYS }],
        groupPermissionMode: PermissionMode.ASK
      }
    });
    expect(larkCreate.ownerProviderUserId).toBeUndefined();
    const wecomCreate = fixture.requests.find((entry) => entry.method === "createMessagingConnection"
      && entry.input.channel === MessagingChannel.WECOM)?.input;
    expect(wecomCreate).toMatchObject({
      channel: MessagingChannel.WECOM,
      wecomConfiguration: { botId: "bot_new" }
    });
    expect(wecomCreate.ownerProviderUserId).toBeUndefined();
    expect(byMethod("beginMessagingCredentialUpload")).toEqual({
      connectionId: "telegram-one",
      expectedRevision: { value: 7n },
      expectedGeneration: 3n
    });
    expect(byMethod("commitMessagingCredential")).toEqual({
      credentialUploadTicketId: "messaging-ticket",
      enable: true
    });
    expect(byMethod("clearMessagingCredential")).toEqual({
      connectionId: "telegram-one",
      expectedRevision: { value: 7n },
      expectedGeneration: 3n
    });
    expect(byMethod("setMessagingConnectionEnabled")).toEqual({
      connectionId: "telegram-one",
      expectedRevision: { value: 7n },
      expectedGeneration: 3n,
      enabled: false
    });
    expect(byMethod("updateTelegramMessagingConfiguration")).toMatchObject({
      connectionId: "telegram-one",
      expectedRevision: { value: 7n },
      expectedGeneration: 3n,
      ownerProviderUserId: "84"
    });
    expect(byMethod("updateDiscordMessagingConfiguration")).toMatchObject({
      connectionId: "discord-one",
      expectedRevision: { value: 8n },
      expectedGeneration: 4n,
      ownerProviderUserId: "876543210987654321",
      configuration: {
        lifecycleAnnouncements: false,
        emojiReactions: DiscordEmojiReactions.MINIMAL,
        replyQuoteDm: DiscordReplyQuoteMode.OFF,
        replyQuoteGroup: DiscordReplyQuoteMode.FIRST,
        groupActivationRules: [{
          guildId: "456789012345678901",
          channelId: "567890123456789012",
          activation: DiscordGroupActivation.DISABLED
        }]
      }
    });
    expect(byMethod("updateDingTalkMessagingConfiguration")).toMatchObject({
      connectionId: "dingtalk-one",
      expectedRevision: { value: 9n },
      expectedGeneration: 5n,
      configuration: {
        appKey: "ding-new-app-key",
        groupActivationRules: [{
          conversationId: "cid-disabled",
          activation: DingTalkGroupActivation.DISABLED
        }]
      }
    });
    expect(byMethod("updateFeishuMessagingConfiguration")).toMatchObject({
      connectionId: "feishu-one",
      expectedRevision: { value: 10n },
      expectedGeneration: 6n,
      configuration: {
        appId: "cli_new",
        lifecycleAnnouncements: false,
        emojiReactions: FeishuEmojiReactions.EXPRESSIVE,
        replyQuoteDm: FeishuReplyQuoteMode.FIRST,
        replyQuoteGroup: FeishuReplyQuoteMode.ALL,
        groupActivationRules: [{ chatId: "oc_new", activation: FeishuGroupActivation.ALWAYS }],
        groupPermissionMode: PermissionMode.ASK
      }
    });
    expect(byMethod("updateWeComMessagingConfiguration")).toEqual({
      connectionId: "wecom-one",
      expectedRevision: { value: 11n },
      expectedGeneration: 7n,
      configuration: {
        $typeName: "joko.v1.WeComMessagingConfiguration",
        botId: "bot_updated"
      }
    });
    expect(byMethod("putMessagingRoute")).toEqual({
      connectionId: "telegram-one",
      expectedRevision: { value: 5n },
      targetId: "target-two",
      providerId: "provider-one",
      modelId: "model-one",
      effort: "high",
      fastMode: true,
      permissionMode: PermissionMode.BYPASS_PERMISSIONS,
      planMode: true
    });
    const rpcText = JSON.stringify(fixture.requests, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value);
    expect(rpcText).not.toContain("telegram-test-token");
    fixture.gateway.disconnect();
  });

  it("fails closed on duplicate channel capabilities and incomplete successful test projections", async () => {
    const fixture = await mount();
    fixture.duplicateCapabilities = true;
    await expect(fixture.gateway.getMessagingSettings()).rejects.toThrow(/duplicate Messaging channel capabilities/iu);
    fixture.duplicateCapabilities = false;
    fixture.incompleteTest = true;
    await expect(fixture.gateway.testMessagingConnection("telegram-one")).rejects.toThrow(/incomplete Messaging connection test result/iu);
    fixture.gateway.disconnect();
  });

  it("fails closed on invalid or cross-channel WeCom configuration", async () => {
    const fixture = await mount();
    fixture.invalidWeComBotId = true;
    await expect(fixture.gateway.getMessagingSettings()).rejects.toThrow(/invalid WeCom configuration/iu);
    fixture.invalidWeComBotId = false;
    fixture.crossChannelWeComConfiguration = true;
    await expect(fixture.gateway.getMessagingSettings()).rejects.toThrow(/WeCom configuration for another Messaging channel/iu);
    await expect(fixture.gateway.createWeComMessagingConnection({ botId: "\n" })).rejects.toThrow(/WeCom Bot ID is required/iu);
    fixture.gateway.disconnect();
  });

  it("maps Slack configuration and sends the paired credential only through a zeroed upload ticket", async () => {
    const fixture = await mount();
    fixture.includeSlack = true;
    const settings = await fixture.gateway.getMessagingSettings();
    expect(settings.connections.find((value) => value.channel === "slack")).toMatchObject({
      id: "slack-one",
      ownerProviderUserId: "U12345678",
      slackConfiguration: {
        lifecycleAnnouncements: true,
        emojiReactions: "minimal",
        groupActivation: { C12345678: "mention", G12345678: "disabled" }
      }
    });
    const configuration = {
      lifecycleAnnouncements: false,
      emojiReactions: "expressive" as const,
      groupActivation: { C87654321: "always" as const }
    };
    await fixture.gateway.createSlackMessagingConnection("W12345678", configuration);
    await fixture.gateway.updateSlackMessagingConfiguration("slack-one", 13n, 9n, "U87654321", configuration);
    const created = fixture.requests.find((entry) => entry.method === "createMessagingConnection"
      && entry.input.channel === MessagingChannel.SLACK)?.input;
    expect(created).toMatchObject({
      channel: MessagingChannel.SLACK,
      ownerProviderUserId: "W12345678",
      slackConfiguration: {
        lifecycleAnnouncements: false,
        emojiReactions: SlackEmojiReactions.EXPRESSIVE,
        groupActivationRules: [{ channelId: "C87654321", activation: SlackGroupActivation.ALWAYS }]
      }
    });
    expect(fixture.requests.find((entry) => entry.method === "updateSlackMessagingConfiguration")?.input)
      .toMatchObject({ connectionId: "slack-one", expectedRevision: { value: 13n }, expectedGeneration: 9n,
        ownerProviderUserId: "U87654321", configuration: created.slackConfiguration });

    let uploaded = "";
    let buffer: Uint8Array | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
      buffer = init.body as Uint8Array;
      uploaded = new TextDecoder().decode(buffer);
      return new Response(undefined, { status: 204 });
    }));
    const secret = JSON.stringify({ format: 1, appToken: "xapp-secret", botToken: "xoxb-secret" });
    await fixture.gateway.saveMessagingCredential("slack-one", 13n, 9n, secret, true);
    expect(uploaded).toBe(secret);
    expect(buffer?.every((byte) => byte === 0)).toBe(true);
    const rpcText = JSON.stringify(fixture.requests, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value);
    expect(rpcText).not.toContain("xapp-secret");
    expect(rpcText).not.toContain("xoxb-secret");
    fixture.gateway.disconnect();
  });

  it("fails closed on malformed Slack owner, channel, enum, or cross-channel projection", async () => {
    const fixture = await mount();
    fixture.includeSlack = true;
    fixture.invalidSlackConfiguration = true;
    await expect(fixture.gateway.getMessagingSettings()).rejects.toThrow(/invalid Slack configuration/iu);
    fixture.invalidSlackConfiguration = false;
    fixture.crossChannelSlackConfiguration = true;
    await expect(fixture.gateway.getMessagingSettings()).rejects.toThrow(/Slack configuration for another Messaging channel/iu);
    fixture.crossChannelSlackConfiguration = false;
    await expect(fixture.gateway.createSlackMessagingConnection("bad-user-id")).rejects.toThrow(/Slack owner user ID/iu);
    await expect(fixture.gateway.createSlackMessagingConnection("U12345678", {
      lifecycleAnnouncements: false,
      emojiReactions: "minimal",
      groupActivation: { "bad-channel": "mention" }
    })).rejects.toThrow(/Slack channel activation/iu);
    fixture.gateway.disconnect();
  });

  it("maps fenced WeChat QR authorization and sends verification code only through a zeroed one-shot upload", async () => {
    const fixture = await mount();
    fixture.includeWeChat = true;
    const settings = await fixture.gateway.getMessagingSettings();
    expect(settings.connections.find((value) => value.channel === "wechat")).toMatchObject({
      id: "wechat-one",
      generation: 8n,
      credentialConfigured: false,
      wechatConfiguration: { format: 1 }
    });
    const created = await fixture.gateway.createWeChatMessagingConnection();
    expect(created.channel).toBe("wechat");
    expect(fixture.requests.find((entry) => entry.method === "createMessagingConnection"
      && entry.input.channel === MessagingChannel.WECHAT)?.input).toEqual({
      channel: MessagingChannel.WECHAT,
      wechatConfiguration: { $typeName: "joko.v1.WeChatMessagingConfiguration" }
    });
    const attempt = await fixture.gateway.beginWeChatAuthorization(created.id, created.revision, created.generation);
    expect(attempt).toMatchObject({
      attemptId: "wechat-attempt",
      connectionId: "wechat-one",
      generation: 8n,
      status: "waiting",
      qrCodeUrl: "https://ilinkai.weixin.qq.com/qr/test"
    });
    fixture.wechatAttemptStatus = WeChatAuthorizationStatus.VERIFICATION_REQUIRED;
    const verification = await fixture.gateway.getWeChatAuthorization(attempt);
    expect(verification.status).toBe("verificationRequired");
    await expect(fixture.gateway.submitWeChatVerificationCode(verification, "A12")).rejects.toThrow(/1–12 digits/u);
    const buffers: Uint8Array[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
      buffers.push(init.body as Uint8Array);
      return new Response(undefined, { status: 204 });
    }));
    const done = await fixture.gateway.submitWeChatVerificationCode(verification, "123456");
    expect(done).toMatchObject({
      status: "succeeded",
      connection: { id: "wechat-one", generation: 9n, credentialConfigured: true }
    });
    expect(buffers).toHaveLength(1);
    expect(buffers[0]!.every((byte) => byte === 0)).toBe(true);
    expect(fixture.requests.find((entry) => entry.method === "submitWeChatVerificationCode")?.input)
      .toMatchObject({ credentialInputTicketId: "wechat-input-ticket", expectedGeneration: 8n });
    const serialized = JSON.stringify(fixture.requests, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value);
    expect(serialized).not.toContain("123456");
    fixture.gateway.disconnect();
  });

  it("rejects untrusted QR URLs and mismatched WeChat authorization generations", async () => {
    const fixture = await mount();
    fixture.includeWeChat = true;
    fixture.invalidWeChatQr = true;
    await expect(fixture.gateway.beginWeChatAuthorization("wechat-one", 12n, 8n)).rejects.toThrow(/untrusted WeChat QR URL/u);
    fixture.invalidWeChatQr = false;
    fixture.wechatWrongGeneration = true;
    await expect(fixture.gateway.beginWeChatAuthorization("wechat-one", 12n, 8n)).rejects.toThrow(/invalid WeChat authorization attempt/u);
    fixture.gateway.disconnect();
  });
});

async function mount() {
  const requests: Array<{ readonly method: string; readonly input: any; readonly signal?: AbortSignal }> = [];
  const fixture = {
    gateway: undefined as unknown as ReturnType<typeof createOrchestratorGateway>,
    requests,
    duplicateCapabilities: false,
    incompleteTest: false,
    invalidWeComBotId: false,
    crossChannelWeComConfiguration: false,
    includeWeChat: false,
    includeSlack: false,
    crossChannelSlackConfiguration: false,
    invalidSlackConfiguration: false,
    invalidWeChatQr: false,
    wechatWrongGeneration: false,
    wechatAttemptStatus: WeChatAuthorizationStatus.WAITING,
    testCalls: 0
  };
  const transport = {
    unary: vi.fn(async (method: any, signal: AbortSignal | undefined, _timeout: unknown, _headers: unknown, input: any) => {
      requests.push({ method: method.localName, input, signal });
      let value: object;
      switch (method.localName) {
        case "getSnapshot": value = { snapshot: {} }; break;
        case "getMessagingSettings": {
          const channels = channelCapabilities();
          value = {
            connections: [
              connection(fixture.crossChannelWeComConfiguration, fixture.crossChannelSlackConfiguration),
              discordConnection(),
              dingTalkConnection(),
              feishuConnection(),
              feishuConnection(MessagingChannel.LARK),
              wecomConnection(fixture.invalidWeComBotId),
              ...(fixture.includeWeChat ? [wechatConnection()] : []),
              ...(fixture.includeSlack ? [slackConnection(fixture.invalidSlackConfiguration)] : [])
            ],
            routes: [route()],
            channels: fixture.duplicateCapabilities ? [...channels, channels[0]] : channels
          };
          break;
        }
        case "beginMessagingCredentialUpload": value = {
          ticket: {
            ticketId: "messaging-ticket",
            relativeEndpoint: "/v1/credential-uploads/messaging-ticket",
            maximumBytes: 1024n
          }
        }; break;
        case "beginWeChatAuthorization":
        case "getWeChatAuthorization": value = {
          attempt: wechatAttempt(
            fixture.wechatAttemptStatus,
            fixture.invalidWeChatQr,
            fixture.wechatWrongGeneration
          )
        }; break;
        case "beginWeChatVerificationInput": value = {
          ticket: {
            ticketId: "wechat-input-ticket",
            relativeEndpoint: "/v1/credential-uploads/wechat-input-ticket",
            maximumBytes: 64n
          }
        }; break;
        case "submitWeChatVerificationCode": value = {
          attempt: wechatAttempt(WeChatAuthorizationStatus.SUCCEEDED)
        }; break;
        case "cancelWeChatAuthorization": value = {
          attempt: wechatAttempt(WeChatAuthorizationStatus.CANCELLED)
        }; break;
        case "testMessagingConnection": {
          fixture.testCalls += 1;
          value = fixture.incompleteTest
            ? { ok: true }
            : fixture.testCalls === 1
              ? { ok: true, providerAccountId: "9001", displayName: "Joko Bot", username: "joko_test_bot" }
              : { ok: false, failure: MessagingConnectionTestFailure.CONNECTION_FAILED };
          break;
        }
        case "putMessagingRoute": value = { route: route({ connectionId: "telegram-one", scopeKey: "connection:telegram-one" }) }; break;
        case "createMessagingConnection": value = {
          connection: input.channel === MessagingChannel.DISCORD ? discordConnection()
            : input.channel === MessagingChannel.DINGTALK ? dingTalkConnection()
              : input.channel === MessagingChannel.FEISHU ? feishuConnection()
                : input.channel === MessagingChannel.LARK ? feishuConnection(MessagingChannel.LARK)
                  : input.channel === MessagingChannel.WECOM ? wecomConnection()
                  : input.channel === MessagingChannel.WECHAT ? wechatConnection()
                  : input.channel === MessagingChannel.SLACK ? slackConnection()
                  : connection()
        }; break;
        case "commitMessagingCredential":
        case "clearMessagingCredential":
        case "setMessagingConnectionEnabled":
        case "updateTelegramMessagingConfiguration": value = { connection: connection() }; break;
        case "updateDiscordMessagingConfiguration": value = { connection: discordConnection() }; break;
        case "updateDingTalkMessagingConfiguration": value = { connection: dingTalkConnection() }; break;
        case "updateFeishuMessagingConfiguration": value = { connection: feishuConnection() }; break;
        case "updateWeComMessagingConfiguration": value = { connection: wecomConnection() }; break;
        case "updateSlackMessagingConfiguration": value = { connection: slackConnection() }; break;
        default: throw new Error(`Unexpected RPC ${method.localName}`);
      }
      return response(method, create(method.output, value));
    }),
    stream: vi.fn(async (method: any) => response(method, idleStream(), true))
  } as unknown as Transport;
  fixture.gateway = createOrchestratorGateway(
    { id: "profile", deviceId: "device", name: "Node", origin: "https://service.example", serverId: "node" },
    "fixture-auth",
    {},
    () => transport
  );
  await fixture.gateway.connect();
  return fixture;
}

function connection(crossChannelWeComConfiguration = false, crossChannelSlackConfiguration = false) {
  return {
    connectionId: "telegram-one",
    channel: MessagingChannel.TELEGRAM,
    generation: 3n,
    enabled: true,
    runtimeStatus: MessagingConnectionRuntimeStatus.CONNECTED,
    credentialConfigured: true,
    ownerProviderUserId: "42",
    providerAccountId: "9001",
    providerUsername: "joko_test_bot",
    telegramConfiguration: {
      emojiReactions: TelegramEmojiReactions.MINIMAL,
      replyQuoteDm: TelegramReplyQuoteMode.OFF,
      replyQuoteGroup: TelegramReplyQuoteMode.FIRST,
      groupActivationRules: [
        { chatId: "-100", activation: TelegramGroupActivation.MENTION },
        { chatId: "-200", activation: TelegramGroupActivation.ALWAYS }
      ]
    },
    ...(crossChannelWeComConfiguration ? { wecomConfiguration: { botId: "bot_cross_channel" } } : {}),
    ...(crossChannelSlackConfiguration ? { slackConfiguration: slackConnection().slackConfiguration } : {}),
    lastConnectedAt: timestamp(4n, 500_000_000),
    createdAt: timestamp(1n),
    updatedAt: timestamp(5n),
    revision: { value: 7n }
  };
}

function discordConnection() {
  return {
    connectionId: "discord-one",
    channel: MessagingChannel.DISCORD,
    generation: 4n,
    enabled: true,
    runtimeStatus: MessagingConnectionRuntimeStatus.CONNECTED,
    credentialConfigured: true,
    ownerProviderUserId: "987654321098765432",
    providerAccountId: "111111111111111111",
    providerUsername: "joko-discord",
    discordConfiguration: {
      lifecycleAnnouncements: true,
      emojiReactions: DiscordEmojiReactions.EXPRESSIVE,
      replyQuoteDm: DiscordReplyQuoteMode.FIRST,
      replyQuoteGroup: DiscordReplyQuoteMode.ALL,
      groupActivationRules: [
        {
          guildId: "123456789012345678",
          channelId: "234567890123456789",
          activation: DiscordGroupActivation.MENTION
        },
        {
          guildId: "123456789012345678",
          channelId: "345678901234567890",
          activation: DiscordGroupActivation.ALWAYS
        }
      ]
    },
    lastConnectedAt: timestamp(5n, 250_000_000),
    createdAt: timestamp(2n),
    updatedAt: timestamp(6n),
    revision: { value: 8n }
  };
}

function dingTalkConnection() {
  return {
    connectionId: "dingtalk-one",
    channel: MessagingChannel.DINGTALK,
    generation: 5n,
    enabled: true,
    runtimeStatus: MessagingConnectionRuntimeStatus.CONNECTED,
    credentialConfigured: true,
    providerAccountId: "ding-app-key",
    dingtalkConfiguration: {
      appKey: "ding-app-key",
      groupActivationRules: [
        { conversationId: "cid-group-one", activation: DingTalkGroupActivation.MENTION },
        { conversationId: "cid-group-two", activation: DingTalkGroupActivation.ALWAYS }
      ]
    },
    lastConnectedAt: timestamp(6n, 125_000_000),
    createdAt: timestamp(3n),
    updatedAt: timestamp(7n),
    revision: { value: 9n }
  };
}

function feishuConnection(channel = MessagingChannel.FEISHU) {
  const lark = channel === MessagingChannel.LARK;
  return {
    connectionId: lark ? "lark-one" : "feishu-one",
    channel,
    generation: 6n,
    enabled: true,
    runtimeStatus: MessagingConnectionRuntimeStatus.CONNECTED,
    credentialConfigured: true,
    ownerProviderUserId: lark ? "ou_lark_owner" : "ou_feishu_owner",
    providerAccountId: lark ? "cli_lark" : "cli_feishu",
    providerUsername: lark ? "Lark bot" : "Feishu bot",
    feishuConfiguration: {
      appId: lark ? "cli_lark" : "cli_feishu",
      lifecycleAnnouncements: true,
      emojiReactions: FeishuEmojiReactions.MINIMAL,
      replyQuoteDm: FeishuReplyQuoteMode.OFF,
      replyQuoteGroup: FeishuReplyQuoteMode.FIRST,
      groupActivationRules: [
        { chatId: "oc_primary", activation: FeishuGroupActivation.MENTION },
        { chatId: "oc_muted", activation: FeishuGroupActivation.DISABLED }
      ],
      groupPermissionMode: PermissionMode.BYPASS_PERMISSIONS
    },
    lastConnectedAt: timestamp(7n, 250_000_000),
    createdAt: timestamp(4n),
    updatedAt: timestamp(8n),
    revision: { value: 10n }
  };
}

function wecomConnection(invalidBotId = false) {
  return {
    connectionId: "wecom-one",
    channel: MessagingChannel.WECOM,
    generation: 7n,
    enabled: true,
    runtimeStatus: MessagingConnectionRuntimeStatus.CONNECTED,
    credentialConfigured: true,
    ownerProviderUserId: "wecom-owner",
    providerAccountId: "bot_wecom",
    wecomConfiguration: { botId: invalidBotId ? "" : "bot_wecom" },
    lastConnectedAt: timestamp(8n, 500_000_000),
    createdAt: timestamp(5n),
    updatedAt: timestamp(9n),
    revision: { value: 11n }
  };
}

function wechatConnection(authorized = false) {
  return {
    connectionId: "wechat-one",
    channel: MessagingChannel.WECHAT,
    generation: authorized ? 9n : 8n,
    enabled: authorized,
    runtimeStatus: authorized ? MessagingConnectionRuntimeStatus.CONNECTING : MessagingConnectionRuntimeStatus.IDLE,
    credentialConfigured: authorized,
    ...(authorized ? { ownerProviderUserId: "wx-user", providerAccountId: "wx-bot" } : {}),
    wechatConfiguration: {},
    createdAt: timestamp(6n),
    updatedAt: timestamp(10n),
    revision: { value: authorized ? 13n : 12n }
  };
}

function slackConnection(invalidConfiguration = false) {
  return {
    connectionId: "slack-one",
    channel: MessagingChannel.SLACK,
    generation: 9n,
    enabled: true,
    runtimeStatus: MessagingConnectionRuntimeStatus.CONNECTED,
    credentialConfigured: true,
    ownerProviderUserId: "U12345678",
    providerAccountId: "T12345678",
    providerUsername: "joko-slack",
    slackConfiguration: {
      lifecycleAnnouncements: true,
      emojiReactions: invalidConfiguration ? 99 : SlackEmojiReactions.MINIMAL,
      groupActivationRules: [
        { channelId: "C12345678", activation: SlackGroupActivation.MENTION },
        { channelId: "G12345678", activation: SlackGroupActivation.DISABLED }
      ]
    },
    lastConnectedAt: timestamp(9n, 500_000_000),
    createdAt: timestamp(7n),
    updatedAt: timestamp(11n),
    revision: { value: 13n }
  };
}

function wechatAttempt(status: WeChatAuthorizationStatus, invalidQr = false, wrongGeneration = false) {
  return {
    attemptId: "wechat-attempt",
    connectionId: "wechat-one",
    generation: wrongGeneration ? 11n : 8n,
    revision: 12n,
    status,
    qrCodeUrl: invalidQr ? "https://elsewhere.example/qr" : "https://ilinkai.weixin.qq.com/qr/test",
    createdAt: timestamp(100n),
    expiresAt: timestamp(400n),
    verificationRetry: false,
    ...(status === WeChatAuthorizationStatus.SUCCEEDED ? { connection: wechatConnection(true) } : {})
  };
}

function route(overrides: Record<string, unknown> = {}) {
  return {
    scopeKey: "global",
    targetId: "target-one",
    backendId: "backend-one",
    providerId: "provider-one",
    modelId: "model-one",
    effort: "high",
    fastMode: false,
    permissionMode: PermissionMode.ASK,
    planMode: false,
    createdAt: timestamp(2n),
    updatedAt: timestamp(3n),
    revision: { value: 5n },
    ...overrides
  };
}

function channelCapabilities() {
  return [
    { channel: MessagingChannel.TELEGRAM, available: true },
    { channel: MessagingChannel.DISCORD, available: true },
    { channel: MessagingChannel.DINGTALK, available: true },
    { channel: MessagingChannel.FEISHU, available: true },
    { channel: MessagingChannel.LARK, available: true },
    { channel: MessagingChannel.WECOM, available: true },
    { channel: MessagingChannel.WECHAT, available: false, reason: "not implemented" },
    { channel: MessagingChannel.SLACK, available: false, reason: "not implemented" }
  ];
}

function timestamp(seconds: bigint, nanos = 0) { return { seconds, nanos }; }
function response(method: any, message: any, stream = false): any { return { stream, service: method.parent, method, header: new Headers(), trailer: new Headers(), message }; }
async function* idleStream(): AsyncIterable<never> { await new Promise<never>(() => undefined); }
