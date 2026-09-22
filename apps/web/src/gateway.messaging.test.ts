import { create } from "@bufbuild/protobuf";
import type { Transport } from "@connectrpc/connect";
import {
  MessagingChannel,
  MessagingConnectionRuntimeStatus,
  MessagingConnectionTestFailure,
  PermissionMode,
  TelegramEmojiReactions,
  TelegramGroupActivation,
  TelegramReplyQuoteMode
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
      connections: [expect.objectContaining({
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
      })],
      routes: [expect.objectContaining({
        scopeKey: "global",
        targetId: "target-one",
        backendId: "backend-one",
        permissionMode: "ask",
        revision: 5n
      })],
      channels: [
        { channel: "telegram", available: true },
        { channel: "discord", available: false, reason: "not implemented" },
        { channel: "dingtalk", available: false, reason: "not implemented" },
        { channel: "feishu", available: false, reason: "not implemented" },
        { channel: "lark", available: false, reason: "not implemented" },
        { channel: "wecom", available: false, reason: "not implemented" },
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
    await fixture.gateway.saveMessagingCredential("telegram-one", 7n, 3n, "telegram-test-token", true, signal);
    await fixture.gateway.clearMessagingCredential("telegram-one", 7n, 3n, signal);
    await fixture.gateway.setMessagingConnectionEnabled("telegram-one", 7n, 3n, false, signal);
    await fixture.gateway.updateTelegramMessagingConfiguration("telegram-one", 7n, 3n, "84", configuration, signal);
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
});

async function mount() {
  const requests: Array<{ readonly method: string; readonly input: any; readonly signal?: AbortSignal }> = [];
  const fixture = {
    gateway: undefined as unknown as ReturnType<typeof createOrchestratorGateway>,
    requests,
    duplicateCapabilities: false,
    incompleteTest: false,
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
            connections: [connection()],
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
        case "createMessagingConnection":
        case "commitMessagingCredential":
        case "clearMessagingCredential":
        case "setMessagingConnectionEnabled":
        case "updateTelegramMessagingConfiguration": value = { connection: connection() }; break;
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

function connection() {
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
    lastConnectedAt: timestamp(4n, 500_000_000),
    createdAt: timestamp(1n),
    updatedAt: timestamp(5n),
    revision: { value: 7n }
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
    { channel: MessagingChannel.DISCORD, available: false, reason: "not implemented" },
    { channel: MessagingChannel.DINGTALK, available: false, reason: "not implemented" },
    { channel: MessagingChannel.FEISHU, available: false, reason: "not implemented" },
    { channel: MessagingChannel.LARK, available: false, reason: "not implemented" },
    { channel: MessagingChannel.WECOM, available: false, reason: "not implemented" },
    { channel: MessagingChannel.WECHAT, available: false, reason: "not implemented" },
    { channel: MessagingChannel.SLACK, available: false, reason: "not implemented" }
  ];
}

function timestamp(seconds: bigint, nanos = 0) { return { seconds, nanos }; }
function response(method: any, message: any, stream = false): any { return { stream, service: method.parent, method, header: new Headers(), trailer: new Headers(), message }; }
async function* idleStream(): AsyncIterable<never> { await new Promise<never>(() => undefined); }
