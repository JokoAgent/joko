import type { BaseMessage, WsFrame } from "@wecom/aibot-node-sdk";

export interface WeComCallbackUpdate {
  readonly callbackId: string;
  readonly receivedAt: number;
  readonly frame: WsFrame<BaseMessage>;
}

export interface WeComInboundPart {
  readonly kind: "image" | "file";
  readonly providerUrl: string;
  readonly aesKey: string | null;
  readonly fileName: string;
  readonly mimeType: string | null;
  readonly maximumBytes: number;
}

export interface WeComInboundContent {
  readonly text: string;
  readonly attachments: readonly WeComInboundPart[];
  readonly unsupported: readonly { readonly code: string; readonly label: string }[];
}

export interface WeComTransientMediaCoordinate {
  readonly providerUrl: string;
  readonly aesKey: string | null;
  readonly fileName: string;
  readonly mimeType: string | null;
  readonly maximumBytes: number;
}
