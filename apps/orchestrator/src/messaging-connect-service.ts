import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import type {
  MessagingChannel as NativeMessagingChannel,
  MessagingConnectionRecord,
  MessagingRouteRecord
} from "@joko/store";

import {
  DEFAULT_DISCORD_MESSAGING_CONFIGURATION,
  DEFAULT_TELEGRAM_MESSAGING_CONFIGURATION,
  MessagingManagerError,
  decodeDingTalkMessagingConfiguration,
  decodeDiscordMessagingConfiguration,
  decodeTelegramMessagingConfiguration,
  type DingTalkMessagingConfiguration,
  type DiscordMessagingConfiguration,
  type MessagingManager,
  type TelegramMessagingConfiguration
} from "./messaging-manager.js";
import { fromProtoRevision, toProtoRevision, toProtoTimestamp } from "./proto-mapper.js";

export interface MessagingRpcOwner {
  readonly connectionId: string;
}

const CHANNELS: readonly NativeMessagingChannel[] = Object.freeze([
  "telegram",
  "discord",
  "dingtalk",
  "feishu",
  "lark",
  "wecom",
  "wechat",
  "slack"
]);

export function createMessagingConnectService(
  manager: MessagingManager | undefined,
  authenticate: (context: HandlerContext) => MessagingRpcOwner
): ServiceImpl<typeof contract.MessagingService> {
  return {
    getMessagingSettings: async (_request, context) => messagingRpc(async () => {
      authenticate(context);
      const owner = requireManager(manager);
      return create(contract.GetMessagingSettingsResponseSchema, {
        connections: owner.listConnections().map(toProtoConnection),
        routes: owner.listRoutes().map(toProtoRoute),
        channels: CHANNELS.map((channel) => create(contract.MessagingChannelCapabilitySchema, {
          channel: toProtoChannel(channel),
          available: isAvailableChannel(channel),
          reason: isAvailableChannel(channel) ? "" : "not_implemented"
        }))
      });
    }),

    createMessagingConnection: async (request, context) => messagingRpc(async () => {
      authenticate(context);
      const owner = requireManager(manager);
      const connection = request.channel === contract.MessagingChannel.TELEGRAM
        ? (() => {
            if (request.discordConfiguration !== undefined || request.dingtalkConfiguration !== undefined) {
              throw new ConnectError("Another channel configuration does not belong to a Telegram connection.", Code.InvalidArgument);
            }
            return owner.createTelegramConnection({
              ownerProviderUserId: request.ownerProviderUserId,
              configuration: request.telegramConfiguration === undefined
                ? DEFAULT_TELEGRAM_MESSAGING_CONFIGURATION
                : fromProtoTelegramConfiguration(request.telegramConfiguration)
            });
          })()
        : request.channel === contract.MessagingChannel.DISCORD
          ? (() => {
              if (request.telegramConfiguration !== undefined || request.dingtalkConfiguration !== undefined) {
                throw new ConnectError("Another channel configuration does not belong to a Discord connection.", Code.InvalidArgument);
              }
              return owner.createDiscordConnection({
                ownerProviderUserId: request.ownerProviderUserId,
                configuration: request.discordConfiguration === undefined
                  ? DEFAULT_DISCORD_MESSAGING_CONFIGURATION
                  : fromProtoDiscordConfiguration(request.discordConfiguration)
              });
            })()
          : request.channel === contract.MessagingChannel.DINGTALK
            ? (() => {
                if (request.telegramConfiguration !== undefined || request.discordConfiguration !== undefined) {
                  throw new ConnectError("Another channel configuration does not belong to a DingTalk connection.", Code.InvalidArgument);
                }
                if (request.ownerProviderUserId !== "") {
                  throw new ConnectError("DingTalk ownership is claimed by the first direct message.", Code.InvalidArgument);
                }
                if (request.dingtalkConfiguration === undefined) {
                  throw new ConnectError("DingTalk configuration is required.", Code.InvalidArgument);
                }
                return owner.createDingTalkConnection({
                  configuration: fromProtoDingTalkConfiguration(request.dingtalkConfiguration)
                });
              })()
            : undefined;
      if (connection === undefined) {
        throw new ConnectError("This Messaging channel is not available yet.", Code.Unimplemented);
      }
      return create(contract.CreateMessagingConnectionResponseSchema, {
        connection: toProtoConnection(connection)
      });
    }),

    beginMessagingCredentialUpload: async (request, context) => messagingRpc(async () => {
      const rpcOwner = authenticate(context);
      const ticket = requireManager(manager).beginCredentialUpload({
        clientConnectionId: rpcOwner.connectionId,
        messagingConnectionId: request.connectionId,
        expectedRevision: requiredRevision(request.expectedRevision, "expected_revision"),
        expectedGeneration: generationNumber(request.expectedGeneration)
      });
      return create(contract.BeginMessagingCredentialUploadResponseSchema, {
        ticket: create(contract.CredentialUploadTicketSchema, {
          ticketId: ticket.credentialUploadTicketId,
          relativeEndpoint: `/v1/credentials/upload/${encodeURIComponent(ticket.credentialUploadTicketId)}`,
          expiresAt: toProtoTimestamp(ticket.expiresAt),
          maximumBytes: BigInt(ticket.maximumBytes)
        })
      });
    }),

    commitMessagingCredential: async (request, context) => messagingRpc(async () => {
      const rpcOwner = authenticate(context);
      const connection = await requireManager(manager).commitCredential({
        credentialUploadTicketId: request.credentialUploadTicketId,
        clientConnectionId: rpcOwner.connectionId,
        enable: request.enable
      });
      return create(contract.CommitMessagingCredentialResponseSchema, {
        connection: toProtoConnection(connection)
      });
    }),

    clearMessagingCredential: async (request, context) => messagingRpc(async () => {
      authenticate(context);
      const connection = await requireManager(manager).clearCredential({
        connectionId: request.connectionId,
        expectedRevision: requiredRevision(request.expectedRevision, "expected_revision"),
        expectedGeneration: generationNumber(request.expectedGeneration)
      });
      return create(contract.ClearMessagingCredentialResponseSchema, {
        connection: toProtoConnection(connection)
      });
    }),

    setMessagingConnectionEnabled: async (request, context) => messagingRpc(async () => {
      authenticate(context);
      const connection = await requireManager(manager).setEnabled({
        connectionId: request.connectionId,
        expectedRevision: requiredRevision(request.expectedRevision, "expected_revision"),
        expectedGeneration: generationNumber(request.expectedGeneration),
        enabled: request.enabled
      });
      return create(contract.SetMessagingConnectionEnabledResponseSchema, {
        connection: toProtoConnection(connection)
      });
    }),

    updateTelegramMessagingConfiguration: async (request, context) => messagingRpc(async () => {
      authenticate(context);
      if (request.configuration === undefined) {
        throw new ConnectError("configuration is required.", Code.InvalidArgument);
      }
      const connection = await requireManager(manager).replaceTelegramConfiguration({
        connectionId: request.connectionId,
        expectedRevision: requiredRevision(request.expectedRevision, "expected_revision"),
        expectedGeneration: generationNumber(request.expectedGeneration),
        ownerProviderUserId: request.ownerProviderUserId,
        configuration: fromProtoTelegramConfiguration(request.configuration)
      });
      return create(contract.UpdateTelegramMessagingConfigurationResponseSchema, {
        connection: toProtoConnection(connection)
      });
    }),

    updateDiscordMessagingConfiguration: async (request, context) => messagingRpc(async () => {
      authenticate(context);
      if (request.configuration === undefined) {
        throw new ConnectError("configuration is required.", Code.InvalidArgument);
      }
      const connection = await requireManager(manager).replaceDiscordConfiguration({
        connectionId: request.connectionId,
        expectedRevision: requiredRevision(request.expectedRevision, "expected_revision"),
        expectedGeneration: generationNumber(request.expectedGeneration),
        ownerProviderUserId: request.ownerProviderUserId,
        configuration: fromProtoDiscordConfiguration(request.configuration)
      });
      return create(contract.UpdateDiscordMessagingConfigurationResponseSchema, {
        connection: toProtoConnection(connection)
      });
    }),

    updateDingTalkMessagingConfiguration: async (request, context) => messagingRpc(async () => {
      authenticate(context);
      if (request.configuration === undefined) {
        throw new ConnectError("configuration is required.", Code.InvalidArgument);
      }
      const connection = await requireManager(manager).replaceDingTalkConfiguration({
        connectionId: request.connectionId,
        expectedRevision: requiredRevision(request.expectedRevision, "expected_revision"),
        expectedGeneration: generationNumber(request.expectedGeneration),
        configuration: fromProtoDingTalkConfiguration(request.configuration)
      });
      return create(contract.UpdateDingTalkMessagingConfigurationResponseSchema, {
        connection: toProtoConnection(connection)
      });
    }),

    testMessagingConnection: async (request, context) => messagingRpc(async () => {
      authenticate(context);
      const result = await requireManager(manager).testConnection(request.connectionId);
      return create(contract.TestMessagingConnectionResponseSchema, result.ok
        ? {
            ok: true,
            failure: contract.MessagingConnectionTestFailure.UNSPECIFIED,
            providerAccountId: result.providerAccountId,
            displayName: result.displayName,
            ...(result.username === undefined ? {} : { username: result.username })
          }
        : {
            ok: false,
            failure: toProtoTestFailure(result.code)
          });
    }),

    putMessagingRoute: async (request, context) => messagingRpc(async () => {
      authenticate(context);
      const route = requireManager(manager).putRoute({
        ...(request.connectionId === undefined ? {} : { connectionId: request.connectionId }),
        ...(request.expectedRevision === undefined
          ? {}
          : { expectedRevision: fromProtoRevision(request.expectedRevision, "expected_revision") }),
        targetId: request.targetId,
        ...(request.providerId === undefined ? {} : { providerId: request.providerId }),
        ...(request.modelId === undefined ? {} : { modelId: request.modelId }),
        ...(request.effort === undefined ? {} : { effort: request.effort }),
        fastMode: request.fastMode,
        permissionMode: fromProtoPermissionMode(request.permissionMode),
        planMode: request.planMode
      });
      return create(contract.PutMessagingRouteResponseSchema, { route: toProtoRoute(route) });
    })
  } satisfies ServiceImpl<typeof contract.MessagingService>;
}

function requireManager(manager: MessagingManager | undefined): MessagingManager {
  if (manager === undefined) {
    throw new ConnectError("Messaging is not available on this node.", Code.Unimplemented);
  }
  return manager;
}

async function messagingRpc<T>(action: () => T | Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (!(error instanceof MessagingManagerError)) throw error;
    const code = error.code === "invalid" ? Code.InvalidArgument
      : error.code === "conflict" ? Code.Aborted
        : error.code === "channel_unavailable" ? Code.Unimplemented
          : error.code === "connection_failed" ? Code.Unavailable
            : Code.FailedPrecondition;
    throw new ConnectError(error.message, code);
  }
}

function requiredRevision(value: contract.Revision | undefined, field: string): bigint {
  if (value === undefined) throw new ConnectError(`${field} is required.`, Code.InvalidArgument);
  return fromProtoRevision(value, field);
}

function generationNumber(value: bigint): number {
  if (value < 1n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ConnectError("expected_generation is invalid.", Code.InvalidArgument);
  }
  return Number(value);
}

function fromProtoTelegramConfiguration(
  value: contract.TelegramMessagingConfiguration
): TelegramMessagingConfiguration {
  const emojiReactions = value.emojiReactions === contract.TelegramEmojiReactions.OFF ? "off"
    : value.emojiReactions === contract.TelegramEmojiReactions.MINIMAL ? "minimal"
      : value.emojiReactions === contract.TelegramEmojiReactions.EXPRESSIVE ? "expressive"
        : undefined;
  const replyQuoteDm = value.replyQuoteDm === contract.TelegramReplyQuoteMode.OFF ? "off"
    : value.replyQuoteDm === contract.TelegramReplyQuoteMode.FIRST ? "first"
      : undefined;
  const replyQuoteGroup = value.replyQuoteGroup === contract.TelegramReplyQuoteMode.OFF ? "off"
    : value.replyQuoteGroup === contract.TelegramReplyQuoteMode.FIRST ? "first"
      : value.replyQuoteGroup === contract.TelegramReplyQuoteMode.ALL ? "all"
        : undefined;
  if (emojiReactions === undefined || replyQuoteDm === undefined || replyQuoteGroup === undefined) {
    throw new ConnectError("Telegram configuration is invalid.", Code.InvalidArgument);
  }
  const groupActivation: Record<string, "mention" | "always" | "disabled"> = {};
  for (const rule of value.groupActivationRules) {
    const chatId = rule.chatId;
    const mapped = rule.activation === contract.TelegramGroupActivation.MENTION ? "mention"
      : rule.activation === contract.TelegramGroupActivation.ALWAYS ? "always"
        : rule.activation === contract.TelegramGroupActivation.DISABLED ? "disabled"
          : undefined;
    if (mapped === undefined || Object.hasOwn(groupActivation, chatId)) {
      throw new ConnectError("Telegram group activation is invalid.", Code.InvalidArgument);
    }
    groupActivation[chatId] = mapped;
  }
  return decodeTelegramMessagingConfiguration({
    format: 1,
    emojiReactions,
    replyQuoteDm,
    replyQuoteGroup,
    groupActivation
  });
}

function toProtoTelegramConfiguration(
  value: TelegramMessagingConfiguration
): contract.TelegramMessagingConfiguration {
  return create(contract.TelegramMessagingConfigurationSchema, {
    emojiReactions: value.emojiReactions === "off" ? contract.TelegramEmojiReactions.OFF
      : value.emojiReactions === "minimal" ? contract.TelegramEmojiReactions.MINIMAL
        : contract.TelegramEmojiReactions.EXPRESSIVE,
    replyQuoteDm: value.replyQuoteDm === "off"
      ? contract.TelegramReplyQuoteMode.OFF
      : contract.TelegramReplyQuoteMode.FIRST,
    replyQuoteGroup: value.replyQuoteGroup === "off" ? contract.TelegramReplyQuoteMode.OFF
      : value.replyQuoteGroup === "first" ? contract.TelegramReplyQuoteMode.FIRST
        : contract.TelegramReplyQuoteMode.ALL,
    groupActivationRules: Object.entries(value.groupActivation).map(([chatId, activation]) => create(
      contract.TelegramGroupActivationRuleSchema,
      {
        chatId,
        activation: activation === "mention" ? contract.TelegramGroupActivation.MENTION
          : activation === "always" ? contract.TelegramGroupActivation.ALWAYS
            : contract.TelegramGroupActivation.DISABLED
      }
    ))
  });
}

function fromProtoDiscordConfiguration(
  value: contract.DiscordMessagingConfiguration
): DiscordMessagingConfiguration {
  const emojiReactions = value.emojiReactions === contract.DiscordEmojiReactions.OFF ? "off"
    : value.emojiReactions === contract.DiscordEmojiReactions.MINIMAL ? "minimal"
      : value.emojiReactions === contract.DiscordEmojiReactions.EXPRESSIVE ? "expressive"
        : undefined;
  const replyQuoteDm = value.replyQuoteDm === contract.DiscordReplyQuoteMode.OFF ? "off"
    : value.replyQuoteDm === contract.DiscordReplyQuoteMode.FIRST ? "first"
      : undefined;
  const replyQuoteGroup = value.replyQuoteGroup === contract.DiscordReplyQuoteMode.OFF ? "off"
    : value.replyQuoteGroup === contract.DiscordReplyQuoteMode.FIRST ? "first"
      : value.replyQuoteGroup === contract.DiscordReplyQuoteMode.ALL ? "all"
        : undefined;
  if (emojiReactions === undefined || replyQuoteDm === undefined || replyQuoteGroup === undefined) {
    throw new ConnectError("Discord configuration is invalid.", Code.InvalidArgument);
  }
  const groupActivation: Record<string, "mention" | "always" | "disabled"> = {};
  for (const rule of value.groupActivationRules) {
    const key = `${rule.guildId}/${rule.channelId}`;
    const mapped = rule.activation === contract.DiscordGroupActivation.MENTION ? "mention"
      : rule.activation === contract.DiscordGroupActivation.ALWAYS ? "always"
        : rule.activation === contract.DiscordGroupActivation.DISABLED ? "disabled"
          : undefined;
    if (mapped === undefined || Object.hasOwn(groupActivation, key)) {
      throw new ConnectError("Discord group activation is invalid.", Code.InvalidArgument);
    }
    groupActivation[key] = mapped;
  }
  return decodeDiscordMessagingConfiguration({
    format: 1,
    lifecycleAnnouncements: value.lifecycleAnnouncements,
    emojiReactions,
    replyQuoteDm,
    replyQuoteGroup,
    groupActivation
  });
}

function toProtoDiscordConfiguration(
  value: DiscordMessagingConfiguration
): contract.DiscordMessagingConfiguration {
  return create(contract.DiscordMessagingConfigurationSchema, {
    lifecycleAnnouncements: value.lifecycleAnnouncements,
    emojiReactions: value.emojiReactions === "off" ? contract.DiscordEmojiReactions.OFF
      : value.emojiReactions === "minimal" ? contract.DiscordEmojiReactions.MINIMAL
        : contract.DiscordEmojiReactions.EXPRESSIVE,
    replyQuoteDm: value.replyQuoteDm === "off"
      ? contract.DiscordReplyQuoteMode.OFF
      : contract.DiscordReplyQuoteMode.FIRST,
    replyQuoteGroup: value.replyQuoteGroup === "off" ? contract.DiscordReplyQuoteMode.OFF
      : value.replyQuoteGroup === "first" ? contract.DiscordReplyQuoteMode.FIRST
        : contract.DiscordReplyQuoteMode.ALL,
    groupActivationRules: Object.entries(value.groupActivation).map(([key, activation]) => {
      const [guildId, channelId] = key.split("/", 2) as [string, string];
      return create(contract.DiscordGroupActivationRuleSchema, {
        guildId,
        channelId,
        activation: activation === "mention" ? contract.DiscordGroupActivation.MENTION
          : activation === "always" ? contract.DiscordGroupActivation.ALWAYS
            : contract.DiscordGroupActivation.DISABLED
      });
    })
  });
}

function fromProtoDingTalkConfiguration(
  value: contract.DingTalkMessagingConfiguration
): DingTalkMessagingConfiguration {
  const groupActivation: Record<string, "mention" | "always" | "disabled"> = {};
  for (const rule of value.groupActivationRules) {
    const mapped = rule.activation === contract.DingTalkGroupActivation.MENTION ? "mention"
      : rule.activation === contract.DingTalkGroupActivation.ALWAYS ? "always"
        : rule.activation === contract.DingTalkGroupActivation.DISABLED ? "disabled"
          : undefined;
    if (mapped === undefined || Object.hasOwn(groupActivation, rule.conversationId)) {
      throw new ConnectError("DingTalk group activation is invalid.", Code.InvalidArgument);
    }
    groupActivation[rule.conversationId] = mapped;
  }
  return decodeDingTalkMessagingConfiguration({
    format: 1,
    appKey: value.appKey,
    groupActivation
  });
}

function toProtoDingTalkConfiguration(
  value: DingTalkMessagingConfiguration
): contract.DingTalkMessagingConfiguration {
  return create(contract.DingTalkMessagingConfigurationSchema, {
    appKey: value.appKey,
    groupActivationRules: Object.entries(value.groupActivation).map(([conversationId, activation]) => create(
      contract.DingTalkGroupActivationRuleSchema,
      {
        conversationId,
        activation: activation === "mention" ? contract.DingTalkGroupActivation.MENTION
          : activation === "always" ? contract.DingTalkGroupActivation.ALWAYS
            : contract.DingTalkGroupActivation.DISABLED
      }
    ))
  });
}

function toProtoConnection(value: MessagingConnectionRecord): contract.MessagingConnection {
  return create(contract.MessagingConnectionSchema, {
    connectionId: value.id,
    channel: toProtoChannel(value.channel),
    generation: BigInt(value.generation),
    enabled: value.enabled,
    runtimeStatus: toProtoRuntimeStatus(value.runtimeStatus),
    credentialConfigured: value.credentialReferenceId !== undefined && value.credentialGeneration !== undefined,
    ...(value.ownerProviderUserId === undefined ? {} : { ownerProviderUserId: value.ownerProviderUserId }),
    ...(value.providerAccountId === undefined ? {} : { providerAccountId: value.providerAccountId }),
    ...(value.providerUsername === undefined ? {} : { providerUsername: value.providerUsername }),
    ...(value.channel !== "telegram" ? {} : {
      telegramConfiguration: toProtoTelegramConfiguration(
        decodeTelegramMessagingConfiguration(value.configuration)
      )
    }),
    ...(value.channel !== "discord" ? {} : {
      discordConfiguration: toProtoDiscordConfiguration(
        decodeDiscordMessagingConfiguration(value.configuration)
      )
    }),
    ...(value.channel !== "dingtalk" ? {} : {
      dingtalkConfiguration: toProtoDingTalkConfiguration(
        decodeDingTalkMessagingConfiguration(value.configuration)
      )
    }),
    ...(value.errorCode === undefined ? {} : { errorCode: value.errorCode }),
    ...(value.errorSummary === undefined ? {} : { errorSummary: value.errorSummary }),
    ...(value.lastConnectedAt === undefined ? {} : { lastConnectedAt: toProtoTimestamp(value.lastConnectedAt) }),
    createdAt: toProtoTimestamp(value.createdAt),
    updatedAt: toProtoTimestamp(value.updatedAt),
    revision: toProtoRevision(value.revision)
  });
}

function toProtoRoute(value: MessagingRouteRecord): contract.MessagingRoute {
  return create(contract.MessagingRouteSchema, {
    scopeKey: value.scopeKey,
    ...(value.connectionId === undefined ? {} : { connectionId: value.connectionId }),
    targetId: value.targetId,
    backendId: value.backendId,
    ...(value.providerId === undefined ? {} : { providerId: value.providerId }),
    ...(value.modelId === undefined ? {} : { modelId: value.modelId }),
    ...(value.effort === undefined ? {} : { effort: value.effort }),
    fastMode: value.fastMode,
    permissionMode: toProtoPermissionMode(value.permissionMode),
    planMode: value.planMode,
    createdAt: toProtoTimestamp(value.createdAt),
    updatedAt: toProtoTimestamp(value.updatedAt),
    revision: toProtoRevision(value.revision)
  });
}

function toProtoChannel(value: NativeMessagingChannel): contract.MessagingChannel {
  switch (value) {
    case "telegram": return contract.MessagingChannel.TELEGRAM;
    case "discord": return contract.MessagingChannel.DISCORD;
    case "dingtalk": return contract.MessagingChannel.DINGTALK;
    case "feishu": return contract.MessagingChannel.FEISHU;
    case "lark": return contract.MessagingChannel.LARK;
    case "wecom": return contract.MessagingChannel.WECOM;
    case "wechat": return contract.MessagingChannel.WECHAT;
    case "slack": return contract.MessagingChannel.SLACK;
  }
}

function isAvailableChannel(value: NativeMessagingChannel): boolean {
  return value === "telegram" || value === "discord" || value === "dingtalk";
}

function toProtoRuntimeStatus(
  value: MessagingConnectionRecord["runtimeStatus"]
): contract.MessagingConnectionRuntimeStatus {
  switch (value) {
    case "idle": return contract.MessagingConnectionRuntimeStatus.IDLE;
    case "connecting": return contract.MessagingConnectionRuntimeStatus.CONNECTING;
    case "connected": return contract.MessagingConnectionRuntimeStatus.CONNECTED;
    case "offline": return contract.MessagingConnectionRuntimeStatus.OFFLINE;
    case "conflict": return contract.MessagingConnectionRuntimeStatus.CONFLICT;
    case "auth_loss": return contract.MessagingConnectionRuntimeStatus.AUTH_LOSS;
    case "error": return contract.MessagingConnectionRuntimeStatus.ERROR;
  }
}

function fromProtoPermissionMode(value: contract.PermissionMode): "ask" | "auto" | "bypassPermissions" {
  if (value === contract.PermissionMode.ASK) return "ask";
  if (value === contract.PermissionMode.AUTO) return "auto";
  if (value === contract.PermissionMode.BYPASS_PERMISSIONS) return "bypassPermissions";
  throw new ConnectError("permission_mode is required.", Code.InvalidArgument);
}

function toProtoPermissionMode(value: MessagingRouteRecord["permissionMode"]): contract.PermissionMode {
  if (value === "auto") return contract.PermissionMode.AUTO;
  if (value === "bypassPermissions") return contract.PermissionMode.BYPASS_PERMISSIONS;
  return contract.PermissionMode.ASK;
}

function toProtoTestFailure(
  value: "invalid" | "conflict" | "credential_unavailable" | "channel_unavailable" | "connection_failed"
): contract.MessagingConnectionTestFailure {
  switch (value) {
    case "invalid": return contract.MessagingConnectionTestFailure.INVALID;
    case "conflict": return contract.MessagingConnectionTestFailure.CONFLICT;
    case "credential_unavailable": return contract.MessagingConnectionTestFailure.CREDENTIAL_UNAVAILABLE;
    case "channel_unavailable": return contract.MessagingConnectionTestFailure.CHANNEL_UNAVAILABLE;
    case "connection_failed": return contract.MessagingConnectionTestFailure.CONNECTION_FAILED;
  }
}
