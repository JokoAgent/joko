export interface DiscordUser {
  readonly id: string;
  readonly username: string;
  readonly discriminator?: string;
  readonly global_name?: string | null;
  readonly bot?: boolean;
}

export interface DiscordGatewayBot {
  readonly url: string;
  readonly shards?: number;
  readonly session_start_limit?: {
    readonly total?: number;
    readonly remaining?: number;
    readonly reset_after?: number;
    readonly max_concurrency?: number;
  };
}

export interface DiscordChannel {
  readonly id: string;
  /** Discord channel type. Only DM, guild text, and guild threads are supported. */
  readonly type: number;
  readonly guild_id?: string;
  readonly parent_id?: string | null;
  readonly name?: string | null;
}

export interface DiscordAttachment {
  readonly id: string;
  readonly filename: string;
  readonly description?: string | null;
  readonly content_type?: string | null;
  readonly size: number;
  readonly url: string;
  readonly proxy_url?: string;
  readonly width?: number | null;
  readonly height?: number | null;
}

export interface DiscordStickerItem {
  readonly id: string;
  readonly name: string;
  readonly format_type?: number;
}

export interface DiscordMessageReference {
  readonly message_id?: string;
  readonly channel_id?: string;
  readonly guild_id?: string;
}

export interface DiscordMessage {
  readonly id: string;
  readonly channel_id: string;
  readonly guild_id?: string;
  readonly author: DiscordUser;
  readonly content: string;
  readonly timestamp: string;
  readonly edited_timestamp?: string | null;
  readonly type?: number;
  readonly attachments?: readonly DiscordAttachment[];
  readonly sticker_items?: readonly DiscordStickerItem[];
  readonly mentions?: readonly DiscordUser[];
  readonly mention_everyone?: boolean;
  readonly referenced_message?: DiscordMessage | null;
  readonly message_reference?: DiscordMessageReference;
}

export interface DiscordInteractionData {
  readonly custom_id?: string;
  readonly component_type?: number;
}

export interface DiscordInteraction {
  readonly id: string;
  readonly application_id: string;
  /** 3 is a message component interaction. */
  readonly type: number;
  readonly data?: DiscordInteractionData;
  readonly guild_id?: string;
  readonly channel_id?: string;
  readonly member?: { readonly user?: DiscordUser };
  readonly user?: DiscordUser;
  readonly message?: DiscordMessage;
  /** Present only in the live Gateway packet and removed before durable admission. */
  readonly token?: string;
}

export interface DiscordReadyEvent {
  readonly session_id: string;
  readonly resume_gateway_url: string;
  readonly user: DiscordUser;
}

export interface DiscordGatewayPacket {
  readonly op: number;
  readonly d?: unknown;
  readonly s?: number | null;
  readonly t?: string | null;
}

export interface DiscordGatewayUpdate {
  readonly sequence: number;
  readonly eventType: "MESSAGE_CREATE" | "INTERACTION_CREATE";
  readonly message?: DiscordMessage;
  readonly interaction?: Omit<DiscordInteraction, "token">;
  readonly channel: DiscordChannel;
}
