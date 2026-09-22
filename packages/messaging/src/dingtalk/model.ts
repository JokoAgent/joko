export interface DingTalkCallbackHeaders {
  readonly appId?: string;
  readonly connectionId?: string;
  readonly contentType?: string;
  readonly messageId: string;
  readonly time?: string;
  readonly topic: string;
}

export interface DingTalkCallbackUpdate {
  readonly callbackMessageId: string;
  readonly payload: unknown;
}

export interface DingTalkInboundEnvelope {
  readonly conversationId: string;
  readonly conversationType: "1" | "2";
  readonly messageId: string;
  readonly messageType: string;
  readonly robotCode: string;
  readonly senderId: string;
  readonly senderName: string;
  readonly sessionWebhook: string | null;
  readonly sessionWebhookExpiresAt: number | null;
  readonly occurredAt: number;
  readonly mentioned: boolean;
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface DingTalkInboundPart {
  readonly kind: "image" | "file";
  readonly downloadCode: string;
  readonly fileName: string;
  readonly mimeType: string | null;
  readonly byteLength: number | null;
}

export interface DingTalkInboundContent {
  readonly text: string;
  readonly attachments: readonly DingTalkInboundPart[];
  readonly unsupported: readonly { readonly code: string; readonly label: string }[];
}
