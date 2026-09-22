import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { OperationalStore } from "@joko/store";
import { FakeBackendAdapter, PI_LIKE_PROFILE } from "@joko/testkit";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { OperationalArtifactRepository } from "./artifact-repository.js";
import { ArtifactStore } from "./artifact-store.js";
import { CredentialManager } from "./credential-manager.js";
import { CredentialVault } from "./credential-vault.js";
import { createMessagingConnectService } from "./messaging-connect-service.js";
import { MessagingManager } from "./messaging-manager.js";
import { SessionHost } from "./session-host.js";
import { mkdtempSync } from "./test-paths.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("MessagingService", () => {
  it("binds credential upload to the authenticated client and projects safe Telegram and Discord settings", async () => {
    const fixture = await createFixture();
    let clientConnectionId = "desktop-one";
    const service = createMessagingConnectService(
      fixture.manager,
      () => ({ connectionId: clientConnectionId })
    );
    const context = {} as HandlerContext;

    const empty = await service.getMessagingSettings(
      create(contract.GetMessagingSettingsRequestSchema),
      context
    );
    expect(empty.connections).toEqual([]);
    const channels = empty.channels ?? [];
    expect(channels).toHaveLength(8);
    expect(channels.find((channel) => channel.channel === contract.MessagingChannel.TELEGRAM))
      .toMatchObject({ available: true, reason: "" });
    expect(channels.find((channel) => channel.channel === contract.MessagingChannel.DISCORD))
      .toMatchObject({ available: true, reason: "" });
    expect(channels.find((channel) => channel.channel === contract.MessagingChannel.DINGTALK))
      .toMatchObject({ available: true, reason: "" });
    expect(channels.find((channel) => channel.channel === contract.MessagingChannel.FEISHU))
      .toMatchObject({ available: true, reason: "" });
    expect(channels.find((channel) => channel.channel === contract.MessagingChannel.LARK))
      .toMatchObject({ available: true, reason: "" });
    expect(channels.filter((channel) => channel.available)).toHaveLength(5);

    const created = await service.createMessagingConnection(create(
      contract.CreateMessagingConnectionRequestSchema,
      {
        channel: contract.MessagingChannel.TELEGRAM,
        ownerProviderUserId: "42",
        telegramConfiguration: create(contract.TelegramMessagingConfigurationSchema, {
          emojiReactions: contract.TelegramEmojiReactions.MINIMAL,
          replyQuoteDm: contract.TelegramReplyQuoteMode.OFF,
          replyQuoteGroup: contract.TelegramReplyQuoteMode.FIRST,
          groupActivationRules: [create(contract.TelegramGroupActivationRuleSchema, {
            chatId: "-100",
            activation: contract.TelegramGroupActivation.MENTION
          })]
        })
      }
    ), context);
    expect(created.connection).toMatchObject({
      channel: contract.MessagingChannel.TELEGRAM,
      generation: 1n,
      credentialConfigured: false,
      ownerProviderUserId: "42",
      runtimeStatus: contract.MessagingConnectionRuntimeStatus.IDLE
    });

    const ticket = await service.beginMessagingCredentialUpload(create(
      contract.BeginMessagingCredentialUploadRequestSchema,
      {
        connectionId: created.connection!.connectionId,
        expectedRevision: created.connection!.revision,
        expectedGeneration: created.connection!.generation
      }
    ), context);
    const uploadTicket = ticket.ticket;
    expect(uploadTicket).toBeDefined();
    if (uploadTicket === undefined) throw new Error("Messaging upload ticket was missing.");
    const uploadTicketId = uploadTicket.ticketId;
    if (uploadTicketId === undefined) throw new Error("Messaging upload ticket ID was missing.");
    expect(uploadTicket).toMatchObject({ maximumBytes: 4096n });
    expect(uploadTicket.relativeEndpoint).toBe(
      `/v1/credentials/upload/${encodeURIComponent(uploadTicketId)}`
    );
    fixture.credentials.upload(uploadTicketId, telegramToken("contract"), clientConnectionId);

    clientConnectionId = "desktop-two";
    await expect(service.commitMessagingCredential(create(
      contract.CommitMessagingCredentialRequestSchema,
      { credentialUploadTicketId: uploadTicketId, enable: false }
    ), context)).rejects.toSatisfy(
      (error: unknown) => error instanceof ConnectError && error.code === Code.InvalidArgument
    );

    clientConnectionId = "desktop-one";
    const retryTicket = await service.beginMessagingCredentialUpload(create(
      contract.BeginMessagingCredentialUploadRequestSchema,
      {
        connectionId: created.connection!.connectionId,
        expectedRevision: created.connection!.revision,
        expectedGeneration: created.connection!.generation
      }
    ), context);
    const retryUploadTicket = retryTicket.ticket;
    expect(retryUploadTicket).toBeDefined();
    if (retryUploadTicket === undefined) throw new Error("Messaging retry upload ticket was missing.");
    const retryUploadTicketId = retryUploadTicket.ticketId;
    if (retryUploadTicketId === undefined) throw new Error("Messaging retry upload ticket ID was missing.");
    fixture.credentials.upload(retryUploadTicketId, telegramToken("commit"), clientConnectionId);
    const committed = await service.commitMessagingCredential(create(
      contract.CommitMessagingCredentialRequestSchema,
      { credentialUploadTicketId: retryUploadTicketId, enable: false }
    ), context);
    expect(committed.connection).toMatchObject({
      credentialConfigured: true,
      generation: 2n,
      enabled: false,
      runtimeStatus: contract.MessagingConnectionRuntimeStatus.OFFLINE
    });
    expect(committed.connection).not.toHaveProperty("credentialReferenceId");
    expect(committed.connection).not.toHaveProperty("credentialGeneration");

    const route = await service.putMessagingRoute(create(contract.PutMessagingRouteRequestSchema, {
      targetId: "target-one",
      providerId: "provider-one",
      modelId: "model-one",
      effort: "high",
      fastMode: true,
      permissionMode: contract.PermissionMode.AUTO,
      planMode: true
    }), context);
    expect(route.route).toMatchObject({
      scopeKey: "global",
      targetId: "target-one",
      backendId: fixture.adapter.id,
      providerId: "provider-one",
      modelId: "model-one",
      permissionMode: contract.PermissionMode.AUTO
    });

    const updated = await service.updateTelegramMessagingConfiguration(create(
      contract.UpdateTelegramMessagingConfigurationRequestSchema,
      {
        connectionId: committed.connection!.connectionId,
        expectedRevision: committed.connection!.revision,
        expectedGeneration: committed.connection!.generation,
        ownerProviderUserId: "84",
        configuration: create(contract.TelegramMessagingConfigurationSchema, {
          emojiReactions: contract.TelegramEmojiReactions.OFF,
          replyQuoteDm: contract.TelegramReplyQuoteMode.FIRST,
          replyQuoteGroup: contract.TelegramReplyQuoteMode.ALL,
          groupActivationRules: [create(contract.TelegramGroupActivationRuleSchema, {
            chatId: "-200",
            activation: contract.TelegramGroupActivation.ALWAYS
          })]
        })
      }
    ), context);
    expect(updated.connection).toMatchObject({
      generation: 3n,
      ownerProviderUserId: "84",
      telegramConfiguration: {
        emojiReactions: contract.TelegramEmojiReactions.OFF,
        replyQuoteDm: contract.TelegramReplyQuoteMode.FIRST,
        replyQuoteGroup: contract.TelegramReplyQuoteMode.ALL,
        groupActivationRules: [{
          chatId: "-200",
          activation: contract.TelegramGroupActivation.ALWAYS
        }]
      }
    });

    const cleared = await service.clearMessagingCredential(create(
      contract.ClearMessagingCredentialRequestSchema,
      {
        connectionId: updated.connection!.connectionId,
        expectedRevision: updated.connection!.revision,
        expectedGeneration: updated.connection!.generation
      }
    ), context);
    expect(cleared.connection).toMatchObject({
      generation: 4n,
      credentialConfigured: false,
      ownerProviderUserId: "84",
      runtimeStatus: contract.MessagingConnectionRuntimeStatus.IDLE
    });

    const settings = await service.getMessagingSettings(
      create(contract.GetMessagingSettingsRequestSchema),
      context
    );
    const discord = await service.createMessagingConnection(create(
      contract.CreateMessagingConnectionRequestSchema,
      {
        channel: contract.MessagingChannel.DISCORD,
        ownerProviderUserId: "111111111111111111",
        discordConfiguration: create(contract.DiscordMessagingConfigurationSchema, {
          lifecycleAnnouncements: true,
          emojiReactions: contract.DiscordEmojiReactions.MINIMAL,
          replyQuoteDm: contract.DiscordReplyQuoteMode.OFF,
          replyQuoteGroup: contract.DiscordReplyQuoteMode.FIRST,
          groupActivationRules: [create(contract.DiscordGroupActivationRuleSchema, {
            guildId: "222222222222222222",
            channelId: "333333333333333333",
            activation: contract.DiscordGroupActivation.MENTION
          })]
        })
      }
    ), context);
    expect(discord.connection).toMatchObject({
      channel: contract.MessagingChannel.DISCORD,
      ownerProviderUserId: "111111111111111111",
      discordConfiguration: {
        lifecycleAnnouncements: true,
        emojiReactions: contract.DiscordEmojiReactions.MINIMAL,
        groupActivationRules: [{
          guildId: "222222222222222222",
          channelId: "333333333333333333",
          activation: contract.DiscordGroupActivation.MENTION
        }]
      }
    });
    expect(discord.connection).not.toHaveProperty("telegramConfiguration");

    const discordUpdated = await service.updateDiscordMessagingConfiguration(create(
      contract.UpdateDiscordMessagingConfigurationRequestSchema,
      {
        connectionId: discord.connection!.connectionId,
        expectedRevision: discord.connection!.revision,
        expectedGeneration: discord.connection!.generation,
        ownerProviderUserId: "444444444444444444",
        configuration: create(contract.DiscordMessagingConfigurationSchema, {
          lifecycleAnnouncements: false,
          emojiReactions: contract.DiscordEmojiReactions.EXPRESSIVE,
          replyQuoteDm: contract.DiscordReplyQuoteMode.FIRST,
          replyQuoteGroup: contract.DiscordReplyQuoteMode.ALL,
          groupActivationRules: [create(contract.DiscordGroupActivationRuleSchema, {
            guildId: "555555555555555555",
            channelId: "666666666666666666",
            activation: contract.DiscordGroupActivation.ALWAYS
          })]
        })
      }
    ), context);
    expect(discordUpdated.connection).toMatchObject({
      generation: 2n,
      ownerProviderUserId: "444444444444444444",
      discordConfiguration: {
        lifecycleAnnouncements: false,
        emojiReactions: contract.DiscordEmojiReactions.EXPRESSIVE,
        replyQuoteDm: contract.DiscordReplyQuoteMode.FIRST,
        replyQuoteGroup: contract.DiscordReplyQuoteMode.ALL,
        groupActivationRules: [{
          guildId: "555555555555555555",
          channelId: "666666666666666666",
          activation: contract.DiscordGroupActivation.ALWAYS
        }]
      }
    });

    const settingsAfterDiscord = await service.getMessagingSettings(
      create(contract.GetMessagingSettingsRequestSchema),
      context
    );
    expect(settingsAfterDiscord.connections).toHaveLength(2);
    expect(settings.routes).toHaveLength(1);
  });

  it("projects DingTalk AppKey/group rules and clears a claimed owner only when AppKey changes", async () => {
    const fixture = await createFixture();
    const service = createMessagingConnectService(fixture.manager, () => ({ connectionId: "desktop" }));
    const context = {} as HandlerContext;
    const created = await service.createMessagingConnection(create(
      contract.CreateMessagingConnectionRequestSchema,
      {
        channel: contract.MessagingChannel.DINGTALK,
        dingtalkConfiguration: create(contract.DingTalkMessagingConfigurationSchema, {
          appKey: "ding-app-key",
          groupActivationRules: [create(contract.DingTalkGroupActivationRuleSchema, {
            conversationId: "group-one",
            activation: contract.DingTalkGroupActivation.MENTION
          })]
        })
      }
    ), context);

    expect(created.connection).toMatchObject({
      channel: contract.MessagingChannel.DINGTALK,
      generation: 1n,
      credentialConfigured: false,
      runtimeStatus: contract.MessagingConnectionRuntimeStatus.IDLE,
      dingtalkConfiguration: {
        appKey: "ding-app-key",
        groupActivationRules: [{
          conversationId: "group-one",
          activation: contract.DingTalkGroupActivation.MENTION
        }]
      }
    });
    expect(created.connection?.ownerProviderUserId).toBeUndefined();
    expect(created.connection).not.toHaveProperty("telegramConfiguration");
    expect(created.connection).not.toHaveProperty("discordConfiguration");

    const createdConnection = created.connection;
    if (createdConnection === undefined) throw new Error("Missing created DingTalk connection.");
    const createdConnectionId = createdConnection.connectionId;
    if (createdConnectionId === undefined) throw new Error("Missing created DingTalk connection identity.");
    const stored = fixture.store.getMessagingConnection(createdConnectionId);
    fixture.store.claimMessagingConnectionOwner({
      connectionId: stored.id,
      expectedRevision: stored.revision,
      expectedGeneration: stored.generation,
      ownerProviderUserId: "ding-owner"
    });
    const claimedSettings = await service.getMessagingSettings(
      create(contract.GetMessagingSettingsRequestSchema),
      context
    );
    const claimed = claimedSettings.connections?.[0];
    if (claimed === undefined) throw new Error("Missing claimed DingTalk connection.");
    expect(claimed.ownerProviderUserId).toBe("ding-owner");

    const sameApp = await service.updateDingTalkMessagingConfiguration(create(
      contract.UpdateDingTalkMessagingConfigurationRequestSchema,
      {
        connectionId: claimed.connectionId,
        expectedRevision: claimed.revision,
        expectedGeneration: claimed.generation,
        configuration: create(contract.DingTalkMessagingConfigurationSchema, {
          appKey: "ding-app-key",
          groupActivationRules: [create(contract.DingTalkGroupActivationRuleSchema, {
            conversationId: "group-two",
            activation: contract.DingTalkGroupActivation.ALWAYS
          })]
        })
      }
    ), context);
    expect(sameApp.connection).toMatchObject({
      generation: 2n,
      ownerProviderUserId: "ding-owner",
      dingtalkConfiguration: {
        appKey: "ding-app-key",
        groupActivationRules: [{
          conversationId: "group-two",
          activation: contract.DingTalkGroupActivation.ALWAYS
        }]
      }
    });

    const changedApp = await service.updateDingTalkMessagingConfiguration(create(
      contract.UpdateDingTalkMessagingConfigurationRequestSchema,
      {
        connectionId: sameApp.connection!.connectionId,
        expectedRevision: sameApp.connection!.revision,
        expectedGeneration: sameApp.connection!.generation,
        configuration: create(contract.DingTalkMessagingConfigurationSchema, {
          appKey: "replacement-app-key",
          groupActivationRules: []
        })
      }
    ), context);
    expect(changedApp.connection).toMatchObject({
      generation: 3n,
      dingtalkConfiguration: { appKey: "replacement-app-key", groupActivationRules: [] }
    });
    expect(changedApp.connection?.ownerProviderUserId).toBeUndefined();
  });

  it("projects Feishu and Lark settings and clears a claimed owner only when App ID changes", async () => {
    const fixture = await createFixture();
    const service = createMessagingConnectService(fixture.manager, () => ({ connectionId: "desktop" }));
    const context = {} as HandlerContext;

    for (const [channel, appId] of [
      [contract.MessagingChannel.FEISHU, "cli_feishu"],
      [contract.MessagingChannel.LARK, "cli_lark"]
    ] as const) {
      const created = await service.createMessagingConnection(create(
        contract.CreateMessagingConnectionRequestSchema,
        {
          channel,
          feishuConfiguration: create(contract.FeishuMessagingConfigurationSchema, {
            appId,
            lifecycleAnnouncements: true,
            emojiReactions: contract.FeishuEmojiReactions.EXPRESSIVE,
            replyQuoteDm: contract.FeishuReplyQuoteMode.FIRST,
            replyQuoteGroup: contract.FeishuReplyQuoteMode.ALL,
            groupActivationRules: [create(contract.FeishuGroupActivationRuleSchema, {
              chatId: "oc_group",
              activation: contract.FeishuGroupActivation.MENTION
            })],
            groupPermissionMode: contract.PermissionMode.BYPASS_PERMISSIONS
          })
        }
      ), context);
      expect(created.connection).toMatchObject({
        channel,
        generation: 1n,
        credentialConfigured: false,
        runtimeStatus: contract.MessagingConnectionRuntimeStatus.IDLE,
        feishuConfiguration: {
          appId,
          lifecycleAnnouncements: true,
          emojiReactions: contract.FeishuEmojiReactions.EXPRESSIVE,
          replyQuoteDm: contract.FeishuReplyQuoteMode.FIRST,
          replyQuoteGroup: contract.FeishuReplyQuoteMode.ALL,
          groupActivationRules: [{
            chatId: "oc_group",
            activation: contract.FeishuGroupActivation.MENTION
          }],
          groupPermissionMode: contract.PermissionMode.BYPASS_PERMISSIONS
        }
      });
      expect(created.connection?.ownerProviderUserId).toBeUndefined();
      expect(created.connection).not.toHaveProperty("dingtalkConfiguration");
      if (created.connection === undefined) throw new Error("Missing Feishu/Lark connection.");
    }

    await expect(service.createMessagingConnection(create(
      contract.CreateMessagingConnectionRequestSchema,
      {
        channel: contract.MessagingChannel.FEISHU,
        ownerProviderUserId: "ou_owner",
        feishuConfiguration: create(contract.FeishuMessagingConfigurationSchema, {
          appId: "cli_invalid",
          emojiReactions: contract.FeishuEmojiReactions.MINIMAL,
          replyQuoteDm: contract.FeishuReplyQuoteMode.FIRST,
          replyQuoteGroup: contract.FeishuReplyQuoteMode.FIRST,
          groupPermissionMode: contract.PermissionMode.ASK
        })
      }
    ), context)).rejects.toSatisfy(
      (error: unknown) => error instanceof ConnectError && error.code === Code.InvalidArgument
    );

    const createdSettings = await service.getMessagingSettings(
      create(contract.GetMessagingSettingsRequestSchema),
      context
    );
    const original = createdSettings.connections?.find(
      (connection) => connection.channel === contract.MessagingChannel.FEISHU
    );
    if (original === undefined) throw new Error("Missing created Feishu connection.");
    const originalConnectionId = original.connectionId;
    if (originalConnectionId === undefined) throw new Error("Missing created Feishu connection identity.");
    const stored = fixture.store.getMessagingConnection(originalConnectionId);
    fixture.store.claimMessagingConnectionOwner({
      connectionId: stored.id,
      expectedRevision: stored.revision,
      expectedGeneration: stored.generation,
      ownerProviderUserId: "ou_owner"
    });
    const claimedSettings = await service.getMessagingSettings(
      create(contract.GetMessagingSettingsRequestSchema),
      context
    );
    const claimed = claimedSettings.connections?.find(
      (connection) => connection.connectionId === originalConnectionId
    );
    if (claimed === undefined) throw new Error("Missing claimed Feishu connection.");
    expect(claimed.ownerProviderUserId).toBe("ou_owner");

    const sameApp = await service.updateFeishuMessagingConfiguration(create(
      contract.UpdateFeishuMessagingConfigurationRequestSchema,
      {
        connectionId: claimed.connectionId,
        expectedRevision: claimed.revision,
        expectedGeneration: claimed.generation,
        configuration: create(contract.FeishuMessagingConfigurationSchema, {
          appId: "cli_feishu",
          lifecycleAnnouncements: false,
          emojiReactions: contract.FeishuEmojiReactions.OFF,
          replyQuoteDm: contract.FeishuReplyQuoteMode.OFF,
          replyQuoteGroup: contract.FeishuReplyQuoteMode.FIRST,
          groupActivationRules: [create(contract.FeishuGroupActivationRuleSchema, {
            chatId: "oc_second",
            activation: contract.FeishuGroupActivation.ALWAYS
          })],
          groupPermissionMode: contract.PermissionMode.ASK
        })
      }
    ), context);
    expect(sameApp.connection).toMatchObject({
      generation: 2n,
      ownerProviderUserId: "ou_owner",
      feishuConfiguration: {
        appId: "cli_feishu",
        lifecycleAnnouncements: false,
        emojiReactions: contract.FeishuEmojiReactions.OFF,
        replyQuoteDm: contract.FeishuReplyQuoteMode.OFF,
        replyQuoteGroup: contract.FeishuReplyQuoteMode.FIRST,
        groupActivationRules: [{
          chatId: "oc_second",
          activation: contract.FeishuGroupActivation.ALWAYS
        }],
        groupPermissionMode: contract.PermissionMode.ASK
      }
    });

    const changedApp = await service.updateFeishuMessagingConfiguration(create(
      contract.UpdateFeishuMessagingConfigurationRequestSchema,
      {
        connectionId: sameApp.connection!.connectionId,
        expectedRevision: sameApp.connection!.revision,
        expectedGeneration: sameApp.connection!.generation,
        configuration: create(contract.FeishuMessagingConfigurationSchema, {
          appId: "cli_replacement",
          emojiReactions: contract.FeishuEmojiReactions.MINIMAL,
          replyQuoteDm: contract.FeishuReplyQuoteMode.FIRST,
          replyQuoteGroup: contract.FeishuReplyQuoteMode.FIRST,
          groupPermissionMode: contract.PermissionMode.ASK
        })
      }
    ), context);
    expect(changedApp.connection).toMatchObject({
      generation: 3n,
      feishuConfiguration: { appId: "cli_replacement" }
    });
    expect(changedApp.connection?.ownerProviderUserId).toBeUndefined();
  });

  it("reports unavailable channels and nodes explicitly", async () => {
    const context = {} as HandlerContext;
    const unavailable = createMessagingConnectService(undefined, () => ({ connectionId: "desktop" }));
    await expect(unavailable.getMessagingSettings(
      create(contract.GetMessagingSettingsRequestSchema),
      context
    )).rejects.toSatisfy(
      (error: unknown) => error instanceof ConnectError && error.code === Code.Unimplemented
    );

    const fixture = await createFixture();
    const service = createMessagingConnectService(fixture.manager, () => ({ connectionId: "desktop" }));
    await expect(service.createMessagingConnection(create(
      contract.CreateMessagingConnectionRequestSchema,
      { channel: contract.MessagingChannel.WECOM }
    ), context)).rejects.toSatisfy(
      (error: unknown) => error instanceof ConnectError && error.code === Code.Unimplemented
    );
  });
});

async function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "joko-messaging-connect-"));
  const store = new OperationalStore(join(root, "operational.db"));
  const artifacts = new ArtifactStore({
    rootDirectory: join(root, "artifacts"),
    repository: new OperationalArtifactRepository(store),
    ingestRoots: [root]
  });
  await artifacts.initialize();
  const credentials = new CredentialManager({
    vault: await CredentialVault.open(join(root, "vault.key")),
    storagePath: join(root, "credentials.json")
  });
  await credentials.initialize();
  const adapter = new FakeBackendAdapter(PI_LIKE_PROFILE);
  let manager: MessagingManager | undefined;
  const host = new SessionHost(store, artifacts, [adapter], {
    onServiceRunSettled: (input) => manager?.onRunSettled(input)
  });
  await host.initialize();
  await host.registerTarget({
    id: "target-one",
    backendId: adapter.id,
    displayName: "Messaging target",
    workspaceRoot: root,
    managed: true,
    trusted: true
  });
  manager = new MessagingManager({ store, credentials, sessionHost: host, artifacts });
  await manager.initialize();
  cleanups.push(async () => {
    await manager?.close().catch(() => undefined);
    await host.dispose().catch(() => undefined);
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, store, artifacts, credentials, adapter, host, manager };
}

function telegramToken(suffix: string): string {
  return `123456:${suffix.padEnd(32, "x")}`;
}
