import { MessagingTransportError, type MessagingAddress } from "../types.js";

const IDENTIFIER = /^[A-Z][A-Z0-9]{8,63}$/u;
const TIMESTAMP = /^\d{1,16}\.\d{1,9}$/u;

export function slackId(value: string, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) throw invalid(`${label} is invalid.`);
  return value;
}

export function slackTimestamp(value: string, label = "Slack message timestamp"): string {
  if (typeof value !== "string" || !TIMESTAMP.test(value)) throw invalid(`${label} is invalid.`);
  return value;
}

export function slackAddress(input: {
  readonly connectionId: string;
  readonly teamId: string;
  readonly channelId: string;
  readonly threadTs: string | null;
  readonly direct: boolean;
}): MessagingAddress {
  return {
    channel: "slack",
    connectionId: input.connectionId,
    providerConversationId: `${slackId(input.teamId, "Slack team identifier")}/${slackId(input.channelId, "Slack channel identifier")}`,
    providerThreadId: input.direct ? null : slackTimestamp(input.threadTs ?? "", "Slack thread timestamp"),
    conversationKind: input.direct ? "direct" : "channel"
  };
}

export function slackAddressParts(address: MessagingAddress, connectionId: string, teamId: string): {
  readonly channelId: string;
  readonly threadTs: string | null;
} {
  if (address.channel !== "slack" || address.connectionId !== connectionId) throw invalid("Slack address belongs to another connection.");
  const [actualTeam, channelId, extra] = address.providerConversationId.split("/");
  if (extra !== undefined || actualTeam !== teamId || channelId === undefined) throw invalid("Slack address belongs to another team.");
  slackId(channelId, "Slack channel identifier");
  if (address.conversationKind === "direct") {
    if (!channelId.startsWith("D") || address.providerThreadId !== null) throw invalid("Invalid Slack direct address.");
    return { channelId, threadTs: null };
  }
  if (address.conversationKind !== "channel" || channelId.startsWith("D") || address.providerThreadId === null) {
    throw invalid("Invalid Slack channel address.");
  }
  return { channelId, threadTs: slackTimestamp(address.providerThreadId) };
}

export function slackAttachmentCoordinate(fileId: string, teamId: string): string {
  return `${slackId(teamId, "Slack team identifier")}/${slackId(fileId, "Slack file identifier")}`;
}

export function decodeSlackAttachmentCoordinate(value: string): { readonly teamId: string; readonly fileId: string } {
  const [teamId, fileId, extra] = value.split("/");
  if (teamId === undefined || fileId === undefined || extra !== undefined) throw invalid("Invalid Slack file coordinate.");
  return { teamId: slackId(teamId, "Slack team identifier"), fileId: slackId(fileId, "Slack file identifier") };
}

function invalid(message: string): MessagingTransportError {
  return new MessagingTransportError("invalid_input", message, { retryable: false, effect: "none" });
}
