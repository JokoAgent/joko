import type {
  MessagingGroupObservation,
  MessagingIgnoredInbound,
  MessagingInboundAttachment,
  MessagingInboundEvent,
  MessagingInboundInteraction,
  MessagingInboundMessage,
  MessagingReplyContext,
  MessagingSpeaker,
  MessagingUnsupportedPart
} from "../types.js";
import { slackAddress, slackAttachmentCoordinate, slackId, slackTimestamp } from "./codec.js";
import type { SlackSocketUpdate } from "./model.js";

export const SLACK_DEFAULT_MAXIMUM_MESSAGE_AGE_MS = 24 * 60 * 60 * 1_000;
export const SLACK_MAXIMUM_INBOUND_FILE_BYTES = 50 * 1024 * 1024;

export interface SlackNormalizationOptions {
  readonly connectionId: string;
  readonly teamId: string;
  readonly ownerUserId: string;
  readonly botUserId: string;
  readonly ownerConversationId: string;
  readonly groupActivation: Readonly<Record<string, "mention" | "always" | "disabled">>;
  readonly now?: () => number;
  readonly maximumMessageAgeMs?: number;
}

export interface SlackNormalizationResult {
  readonly events: readonly MessagingInboundEvent[];
  readonly groupObservations: readonly MessagingGroupObservation[];
  readonly ignored: readonly MessagingIgnoredInbound[];
}

export function normalizeSlackUpdates(
  updates: readonly SlackSocketUpdate[],
  options: SlackNormalizationOptions
): SlackNormalizationResult {
  const events: MessagingInboundEvent[] = [];
  const groupObservations: MessagingGroupObservation[] = [];
  const ignored: MessagingIgnoredInbound[] = [];
  const now = options.now?.() ?? Date.now();
  const maximumAge = options.maximumMessageAgeMs ?? SLACK_DEFAULT_MAXIMUM_MESSAGE_AGE_MS;
  const seen = new Set<string>();
  for (const update of updates) {
    const fallback = `slack:envelope:${update.envelopeId}`;
    try {
      const normalized = update.type === "events_api"
        ? normalizeEvent(update, options, now, maximumAge)
        : update.type === "interactive"
          ? normalizeInteraction(update, options, now, maximumAge)
          : update.type === "slash_commands"
            ? normalizeSlashCommand(update, options, now)
            : { event: null, observation: null, ignored: ignore(fallback, "unsupported_update") };
      if (normalized.event !== null) {
        const identity = normalized.event.providerRequestIds[0]!;
        if (seen.has(identity)) ignored.push(ignore(identity, "duplicate"));
        else {
          seen.add(identity);
          events.push(normalized.event);
          if (normalized.observation !== null) groupObservations.push(normalized.observation);
        }
      } else {
        if (normalized.observation !== null) groupObservations.push(normalized.observation);
        if (normalized.ignored !== null) ignored.push(normalized.ignored);
      }
    } catch {
      ignored.push(ignore(fallback, "invalid"));
    }
  }
  return { events, groupObservations, ignored };
}

type Normalized = {
  readonly event: MessagingInboundEvent | null;
  readonly observation: MessagingGroupObservation | null;
  readonly ignored: MessagingIgnoredInbound | null;
};

function normalizeEvent(
  update: SlackSocketUpdate,
  options: SlackNormalizationOptions,
  now: number,
  maximumAge: number
): Normalized {
  const wrapper = record(update.payload);
  const eventId = string(wrapper.event_id, 1, 128);
  const requestId = eventId === null ? `slack:envelope:${update.envelopeId}` : `slack:event:${eventId}`;
  if (wrapper.type !== "event_callback" || wrapper.team_id !== options.teamId || eventId === null) {
    return empty(requestId, "unauthorized");
  }
  const event = record(wrapper.event);
  if (event.type !== "message" && event.type !== "app_mention") return empty(requestId, "unsupported_update");
  const channel = slackId(string(event.channel, 1, 64) ?? "", "Slack channel identifier");
  const ts = slackTimestamp(string(event.ts, 1, 32) ?? "");
  const user = slackId(string(event.user, 1, 64) ?? "", "Slack user identifier");
  const sourceId = `slack:message:${options.teamId}:${channel}:${ts}`;
  const subtype = event.subtype;
  if (subtype !== undefined && subtype !== "file_share") return empty(sourceId, "service_message", channel, user);
  if (event.bot_id !== undefined || user === options.botUserId) return empty(sourceId, "service_message", channel, user);
  const occurredAt = Math.trunc(Number(ts) * 1_000);
  if (!Number.isSafeInteger(occurredAt) || occurredAt > now + 5 * 60_000) return empty(sourceId, "invalid", channel, user);
  if (now - occurredAt > maximumAge) return empty(sourceId, "stale", channel, user);
  const direct = channel.startsWith("D") || event.channel_type === "im";
  if (direct && !channel.startsWith("D")) return empty(sourceId, "invalid", channel, user);
  if (direct && user !== options.ownerUserId) return empty(sourceId, "unauthorized", channel, user);
  const rule = direct ? null : options.groupActivation[channel];
  if (!direct && (rule === undefined || rule === "disabled")) return empty(sourceId, "unsupported_chat", channel, user);
  const rawText = string(event.text, 0, 256 * 1024) ?? "";
  const mention = rawText.includes(`<@${options.botUserId}>`);
  const threadTs = direct ? null : slackTimestamp(string(event.thread_ts, 1, 32) ?? ts, "Slack thread timestamp");
  const isThreadReply = !direct && threadTs !== ts;
  const speaker = speakerOf(user, options.ownerUserId);
  const address = slackAddress({
    connectionId: options.connectionId,
    teamId: options.teamId,
    channelId: channel,
    threadTs,
    direct
  });
  const cleanedText = rawText.split(`<@${options.botUserId}>`).join("").trim();
  const files = Array.isArray(event.files) ? event.files.slice(0, 20) : [];
  const attachments: MessagingInboundAttachment[] = [];
  const unsupported: MessagingUnsupportedPart[] = [];
  for (const candidate of files) {
    const file = record(candidate);
    const fileId = string(file.id, 1, 64);
    if (fileId === null) { unsupported.push({ code: "file_unavailable", label: "Slack file was unavailable" }); continue; }
    const size = integer(file.size);
    if (size !== null && size > SLACK_MAXIMUM_INBOUND_FILE_BYTES) {
      unsupported.push({ code: "file_too_large", label: "Slack file exceeds the inbound limit" });
      continue;
    }
    const mimeType = string(file.mimetype, 1, 256);
    attachments.push({
      providerFileId: slackAttachmentCoordinate(fileId, options.teamId),
      providerUniqueFileId: fileId,
      kind: mimeType?.startsWith("image/") ? "image" : "file",
      fileName: string(file.name, 1, 255) ?? fileId,
      mimeType,
      byteLength: size
    });
  }
  const observation = direct ? null : {
    address,
    messageId: ts,
    speaker,
    occurredAt,
    text: cleanedText,
    attachmentNames: attachments.map((attachment) => attachment.fileName)
  } satisfies MessagingGroupObservation;
  if (rule === "mention" && !mention && !isThreadReply) {
    return { event: null, observation, ignored: ignore(sourceId, "unaddressed", channel, user) };
  }
  const replyContext: MessagingReplyContext | null = isThreadReply && threadTs !== null
    ? { providerMessageId: threadTs, author: "", text: "", isBot: false, attachmentCount: 0 }
    : null;
  const message: MessagingInboundMessage = {
    kind: "message",
    providerRequestIds: [sourceId, requestId],
    messageId: ts,
    address,
    speaker,
    occurredAt,
    text: cleanedText,
    ambient: rule === "mention" && !mention,
    protectedContent: false,
    attachments,
    unsupported,
    replyContext
  };
  return { event: message, observation, ignored: null };
}

function normalizeInteraction(
  update: SlackSocketUpdate,
  options: SlackNormalizationOptions,
  now: number,
  maximumAge: number
): Normalized {
  const body = record(update.payload);
  const fallback = `slack:envelope:${update.envelopeId}`;
  if (body.type !== "block_actions" || record(body.team).id !== options.teamId) return empty(fallback, "unsupported_update");
  const user = slackId(string(record(body.user).id, 1, 64) ?? "", "Slack user identifier");
  const channel = slackId(string(record(body.channel).id ?? record(body.container).channel_id, 1, 64) ?? "", "Slack channel identifier");
  const message = record(body.message);
  const messageTs = slackTimestamp(string(message.ts ?? record(body.container).message_ts, 1, 32) ?? "");
  const action = record(Array.isArray(body.actions) ? body.actions[0] : undefined);
  const actionId = string(action.action_id, 1, 255);
  const actionValue = string(action.value, 1, 2_000);
  const actionTs = string(action.action_ts, 1, 32);
  if (actionValue === null || actionId === null || actionValue !== actionId || actionTs === null || /[\u0000-\u001f\u007f]/u.test(actionId)) {
    return empty(fallback, "invalid", channel, user);
  }
  const occurredAt = Math.trunc(Number(actionTs) * 1_000);
  if (!Number.isSafeInteger(occurredAt) || occurredAt > now + 5 * 60_000 || now - occurredAt > maximumAge) {
    return empty(fallback, "stale", channel, user);
  }
  if (user !== options.ownerUserId) return empty(fallback, "unauthorized", channel, user);
  const direct = channel.startsWith("D");
  const rule = direct ? null : options.groupActivation[channel];
  if (!direct && (rule === undefined || rule === "disabled")) return empty(fallback, "unsupported_chat", channel, user);
  const threadTs = direct ? null : slackTimestamp(
    string(message.thread_ts, 1, 32) ?? string(record(body.container).thread_ts, 1, 32) ?? messageTs,
    "Slack thread timestamp"
  );
  const sourceId = `slack:action:${options.teamId}:${channel}:${messageTs}:${user}:${actionTs}:${actionId}`;
  const interaction: MessagingInboundInteraction = {
    kind: "interaction",
    providerRequestIds: [sourceId, fallback],
    interactionId: sourceId,
    messageId: messageTs,
    address: slackAddress({ connectionId: options.connectionId, teamId: options.teamId, channelId: channel, threadTs, direct }),
    speaker: speakerOf(user, options.ownerUserId),
    actionValue: actionId,
    occurredAt
  };
  return { event: interaction, observation: null, ignored: null };
}

function normalizeSlashCommand(update: SlackSocketUpdate, options: SlackNormalizationOptions, now: number): Normalized {
  const body = record(update.payload);
  const requestId = `slack:command:${update.envelopeId}`;
  if (body.command !== "/joko" || body.team_id !== options.teamId) return empty(requestId, "unsupported_update");
  const channel = slackId(string(body.channel_id, 1, 64) ?? "", "Slack command channel identifier");
  const user = slackId(string(body.user_id, 1, 64) ?? "", "Slack command user identifier");
  if (channel !== options.ownerConversationId || !channel.startsWith("D") || user !== options.ownerUserId) {
    return empty(requestId, "unauthorized", channel, user);
  }
  const raw = string(body.text, 1, 256)?.trim() ?? "";
  const action = raw.split(/\s+/u, 1)[0]?.toLowerCase();
  if (action === undefined || !["new", "stop", "status", "model", "effort", "permission", "help"].includes(action)) {
    return empty(requestId, "unsupported_update", channel, user);
  }
  const tail = raw.slice(action.length).trim();
  const text = `/${action}${tail.length === 0 ? "" : ` ${tail}`}`;
  const message: MessagingInboundMessage = {
    kind: "message",
    providerRequestIds: [requestId],
    messageId: requestId,
    address: slackAddress({ connectionId: options.connectionId, teamId: options.teamId, channelId: channel, threadTs: null, direct: true }),
    speaker: speakerOf(user, options.ownerUserId),
    occurredAt: now,
    text,
    ambient: false,
    protectedContent: false,
    attachments: [],
    unsupported: [],
    replyContext: null
  };
  return { event: message, observation: null, ignored: null };
}

function speakerOf(user: string, owner: string): MessagingSpeaker {
  return { providerUserId: user, displayName: user, username: null, isBot: false, isOwner: user === owner };
}

function empty(
  requestId: string,
  reason: MessagingIgnoredInbound["reason"],
  channel: string | null = null,
  user: string | null = null
): Normalized {
  return { event: null, observation: null, ignored: ignore(requestId, reason, channel, user) };
}

function ignore(
  providerRequestId: string,
  reason: MessagingIgnoredInbound["reason"],
  providerConversationId: string | null = null,
  providerUserId: string | null = null
): MessagingIgnoredInbound {
  return { providerRequestId, reason, providerConversationId, providerUserId };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function string(value: unknown, minimum: number, maximum: number): string | null {
  return typeof value === "string" && value.length >= minimum && value.length <= maximum ? value : null;
}

function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
