import type {
  MessagingGroupObservation,
  MessagingIgnoredInbound,
  MessagingInboundEvent
} from "../types.js";

export const WECHAT_MESSAGE_TYPE = { none: 0, user: 1, bot: 2 } as const;
export const WECHAT_MESSAGE_STATE = { fresh: 0, generating: 1, finished: 2 } as const;
export const WECHAT_ITEM_TYPE = { none: 0, text: 1, image: 2, voice: 3, file: 4, video: 5 } as const;

export interface WeChatRawMedia {
  readonly encrypt_query_param?: string;
  readonly aes_key?: string;
  readonly encrypt_type?: number;
  readonly full_url?: string;
}

export interface WeChatRawItem {
  readonly type?: number;
  readonly msg_id?: string;
  readonly ref_msg?: { readonly title?: string; readonly message_item?: WeChatRawItem };
  readonly text_item?: { readonly text?: string };
  readonly image_item?: { readonly media?: WeChatRawMedia; readonly aeskey?: string; readonly mid_size?: number };
  readonly voice_item?: {
    readonly media?: WeChatRawMedia;
    readonly encode_type?: number;
    readonly text?: string;
    readonly playtime?: number;
  };
  readonly file_item?: {
    readonly media?: WeChatRawMedia;
    readonly file_name?: string;
    readonly len?: string;
    readonly md5?: string;
  };
  readonly video_item?: {
    readonly media?: WeChatRawMedia;
    readonly video_size?: number;
    readonly play_length?: number;
  };
}

export interface WeChatRawMessage {
  readonly seq?: number;
  readonly message_id?: number | string;
  readonly from_user_id?: string;
  readonly to_user_id?: string;
  readonly client_id?: string;
  readonly create_time_ms?: number;
  readonly message_type?: number;
  readonly message_state?: number;
  readonly item_list?: readonly WeChatRawItem[];
  /** Provider-private sending capability. Never copy this into a public event. */
  readonly context_token?: string;
  readonly run_id?: string;
}

export interface WeChatCredentials {
  readonly token: string;
  readonly botId: string;
  readonly userId: string;
  readonly baseUrl: string;
}

export type WeChatAuthorizationEvent =
  | { readonly status: "waiting" | "scanned"; readonly attemptId: string; readonly qrCodeUrl: string; readonly expiresAt: number }
  | { readonly status: "verification_required"; readonly attemptId: string; readonly retry: boolean }
  | { readonly status: "qr_refreshed"; readonly attemptId: string; readonly qrCodeUrl: string; readonly expiresAt: number }
  | { readonly status: "confirmed"; readonly attemptId: string; readonly credentials: WeChatCredentials }
  | { readonly status: "expired" | "cancelled"; readonly attemptId: string };

export interface WeChatPollResult {
  readonly updates: readonly WeChatRawMessage[];
  readonly nextCursor: string;
  readonly suggestedTimeoutMs?: number;
}

export interface WeChatPrivateContext {
  readonly messageId: string;
  readonly providerConversationId: string;
  readonly contextToken: string;
}

export interface WeChatNormalizationResult {
  readonly events: readonly MessagingInboundEvent[];
  readonly interactionReplyCandidates: readonly [];
  readonly groupObservations: readonly MessagingGroupObservation[];
  readonly ignored: readonly MessagingIgnoredInbound[];
  readonly privateContexts: readonly WeChatPrivateContext[];
}

export interface WeChatSendContext {
  readonly contextToken: string;
  /** Stable durable delivery identity supplied by the caller. */
  readonly clientId: string;
  readonly runId?: string;
}

export type WeChatTransientMediaKind = "image" | "voice" | "file" | "video";

export interface WeChatTransientMedia {
  readonly kind: WeChatTransientMediaKind;
  readonly downloadUrl?: string;
  readonly encryptedQuery?: string;
  readonly aesKeyBase64?: string;
  readonly aesKeyHex?: string;
  readonly fileName?: string;
  readonly byteLength?: number;
  readonly encryptedByteLength?: number;
  readonly voiceEncoding?: number;
  readonly transcript?: string;
  readonly md5Hex?: string;
}

export interface WeChatDecodedMessage {
  readonly messageId: string;
  readonly senderId: string;
  readonly recipientId?: string;
  readonly clientId?: string;
  readonly occurredAt: number;
  readonly contextToken: string;
  readonly text: string;
  readonly media: readonly WeChatTransientMedia[];
  readonly unsupported: readonly { readonly code: string; readonly label: string }[];
  readonly replyContext: {
    readonly providerMessageId: string;
    readonly author: string;
    readonly text: string;
    readonly isBot: boolean;
    readonly attachmentCount: number;
  } | null;
}
