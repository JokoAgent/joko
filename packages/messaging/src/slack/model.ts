export interface SlackSocketUpdate {
  readonly envelopeId: string;
  readonly type: "events_api" | "interactive" | "slash_commands" | "unknown";
  readonly payload: unknown;
  readonly acceptsResponsePayload: boolean;
}

export interface SlackPollResult {
  readonly updates: readonly SlackSocketUpdate[];
  /** Local admission watermark; Slack Socket Mode has no server-side resumable cursor. */
  readonly nextCursor: string;
  readonly envelopeId: string | null;
}

export interface SlackOutboundAttachment {
  readonly kind: "image" | "file";
  readonly bytes: Uint8Array;
  readonly fileName: string;
  readonly mimeType: string;
}
