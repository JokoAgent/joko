export const MESSAGING_CHANNELS = [
  "telegram",
  "discord",
  "dingtalk",
  "feishu",
  "lark",
  "wecom",
  "wechat",
  "slack"
] as const;

export type MessagingChannel = (typeof MESSAGING_CHANNELS)[number];
export type MessagingConversationKind = "direct" | "group" | "channel";

export interface MessagingAddress {
  readonly channel: MessagingChannel;
  readonly connectionId: string;
  readonly providerConversationId: string;
  readonly providerThreadId: string | null;
  readonly conversationKind: MessagingConversationKind;
}

export interface MessagingSpeaker {
  readonly providerUserId: string;
  readonly displayName: string;
  readonly username: string | null;
  readonly isBot: boolean;
  readonly isOwner: boolean;
}

export type MessagingAttachmentKind = "image" | "file";

/** Provider-owned metadata only. Bytes are adopted by the Artifact owner later. */
export interface MessagingInboundAttachment {
  readonly providerFileId: string;
  readonly providerUniqueFileId: string | null;
  readonly kind: MessagingAttachmentKind;
  readonly fileName: string;
  readonly mimeType: string | null;
  readonly byteLength: number | null;
}

export interface MessagingUnsupportedPart {
  readonly code: string;
  readonly label: string;
}

export interface MessagingReplyContext {
  /** Provider identity of the quoted message, used only for exact reply routing. */
  readonly providerMessageId: string;
  readonly author: string;
  readonly text: string;
  readonly isBot: boolean;
  readonly attachmentCount: number;
}

export interface MessagingInboundMessage {
  readonly kind: "message";
  /** Stable transport request identities consumed by one normalized message. */
  readonly providerRequestIds: readonly string[];
  readonly messageId: string;
  readonly address: MessagingAddress;
  readonly speaker: MessagingSpeaker;
  readonly occurredAt: number;
  readonly text: string;
  readonly ambient: boolean;
  readonly protectedContent: boolean;
  readonly attachments: readonly MessagingInboundAttachment[];
  readonly unsupported: readonly MessagingUnsupportedPart[];
  readonly replyContext: MessagingReplyContext | null;
}

export interface MessagingInboundInteraction {
  readonly kind: "interaction";
  readonly providerRequestIds: readonly string[];
  readonly interactionId: string;
  readonly messageId: string;
  readonly address: MessagingAddress;
  readonly speaker: MessagingSpeaker;
  /** Opaque provider value; the owning manager validates it against a durable claim. */
  readonly actionValue: string;
  readonly occurredAt: number;
}

export type MessagingInboundEvent = MessagingInboundMessage | MessagingInboundInteraction;

export interface MessagingGroupObservation {
  readonly address: MessagingAddress;
  readonly messageId: string;
  readonly speaker: MessagingSpeaker;
  readonly occurredAt: number;
  readonly text: string;
  readonly attachmentNames: readonly string[];
}

export type MessagingIgnoredReason =
  | "duplicate"
  | "stale"
  | "unauthorized"
  | "unaddressed"
  | "unsupported_chat"
  | "unsupported_update"
  | "service_message"
  | "invalid";

/** Contains coordinates and reason only; ignored message bodies are deliberately absent. */
export interface MessagingIgnoredInbound {
  readonly providerRequestId: string;
  readonly reason: MessagingIgnoredReason;
  readonly providerConversationId: string | null;
  readonly providerUserId: string | null;
}

export type MessagingEffectCertainty = "none" | "unknown";

export type MessagingTransportErrorCode =
  | "invalid_credential"
  | "conflict"
  | "rate_limited"
  | "provider_rejected"
  | "provider_unavailable"
  | "network"
  | "malformed_response"
  | "cancelled"
  | "payload_too_large"
  | "invalid_input";

export class MessagingTransportError extends Error {
  constructor(
    readonly code: MessagingTransportErrorCode,
    message: string,
    readonly options: {
      readonly retryable: boolean;
      readonly effect: MessagingEffectCertainty;
      readonly providerStatus?: number;
      readonly retryAfterMs?: number;
    }
  ) {
    super(message);
    this.name = "MessagingTransportError";
  }
}

export interface MessagingConnectionProbe {
  readonly channel: MessagingChannel;
  readonly connectionId: string;
  readonly generation: number;
  readonly providerAccountId: string;
  readonly displayName: string;
  readonly username: string | null;
}

export interface MessagingDownloadedAttachment {
  readonly bytes: Uint8Array;
  readonly fileName: string;
  readonly mimeType: string;
}

export interface MessagingSendReceipt {
  readonly providerMessageId: string;
  readonly address: MessagingAddress;
}
