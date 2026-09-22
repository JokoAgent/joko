import type { MessagingReplyContext } from "../types.js";

export type FeishuService = "feishu" | "lark";

export interface FeishuMention {
  readonly key: string;
  readonly openId: string;
  readonly name: string;
}

export interface FeishuMessageEnvelope {
  readonly messageId: string;
  readonly chatId: string;
  readonly chatType: "p2p" | "group";
  readonly messageType: string;
  readonly content: string;
  readonly senderOpenId: string;
  readonly senderName: string;
  readonly senderIsBot: boolean;
  readonly threadId: string | null;
  readonly parentId: string | null;
  readonly rootId: string | null;
  readonly mentions: readonly FeishuMention[];
  readonly occurredAt: number;
  readonly replyContext?: MessagingReplyContext | null;
}

export interface FeishuCardActionEnvelope {
  readonly callbackId: string;
  readonly messageId: string;
  readonly chatId: string;
  readonly operatorOpenId: string;
  readonly actionValue: string;
  readonly address: {
    readonly channel: FeishuService;
    readonly connectionId: string;
    readonly providerConversationId: string;
    readonly providerThreadId: string | null;
    readonly conversationKind: "direct" | "group";
  };
  readonly occurredAt: number;
}

export type FeishuCallbackUpdate =
  | {
      readonly callbackId: string;
      readonly kind: "message";
      readonly message: FeishuMessageEnvelope;
    }
  | {
      readonly callbackId: string;
      readonly kind: "card_action";
      readonly action: FeishuCardActionEnvelope;
    };

export interface FeishuInboundPart {
  readonly kind: "image" | "file";
  readonly providerKey: string;
  readonly fileName: string;
  readonly mimeType: string | null;
  readonly byteLength: number | null;
}

export interface FeishuInboundContent {
  readonly text: string;
  readonly attachments: readonly FeishuInboundPart[];
  readonly unsupported: readonly { readonly code: string; readonly label: string }[];
}

export interface FeishuHistoryMessage {
  readonly messageId: string;
  readonly chatId: string;
  readonly threadId: string | null;
  readonly senderOpenId: string;
  readonly senderName: string;
  readonly senderIsBot: boolean;
  readonly messageType: string;
  readonly content: string;
  readonly occurredAt: number;
}
