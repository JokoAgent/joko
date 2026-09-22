export interface TelegramUser {
  readonly id: number;
  readonly is_bot: boolean;
  readonly first_name: string;
  readonly last_name?: string;
  readonly username?: string;
}

export interface TelegramChat {
  readonly id: number;
  readonly type: "private" | "group" | "supergroup" | "channel";
  readonly title?: string;
  readonly username?: string;
  readonly first_name?: string;
  readonly last_name?: string;
}

export interface TelegramMessageEntity {
  readonly type: string;
  readonly offset: number;
  readonly length: number;
}

export interface TelegramPhotoSize {
  readonly file_id: string;
  readonly file_unique_id: string;
  readonly width: number;
  readonly height: number;
  readonly file_size?: number;
}

export interface TelegramDocument {
  readonly file_id: string;
  readonly file_unique_id: string;
  readonly file_name?: string;
  readonly mime_type?: string;
  readonly file_size?: number;
}

export interface TelegramMessage {
  readonly message_id: number;
  readonly from?: TelegramUser;
  readonly chat: TelegramChat;
  readonly date: number;
  readonly message_thread_id?: number;
  readonly media_group_id?: string;
  readonly is_topic_message?: boolean;
  readonly has_protected_content?: boolean;
  readonly reply_to_message?: TelegramMessage;
  readonly text?: string;
  readonly caption?: string;
  readonly entities?: readonly TelegramMessageEntity[];
  readonly caption_entities?: readonly TelegramMessageEntity[];
  readonly photo?: readonly TelegramPhotoSize[];
  readonly document?: TelegramDocument;
  readonly sticker?: { readonly emoji?: string; readonly set_name?: string };
  readonly voice?: { readonly duration?: number };
  readonly audio?: { readonly file_name?: string };
  readonly video?: { readonly file_name?: string };
  readonly video_note?: { readonly duration?: number };
  readonly new_chat_members?: readonly TelegramUser[];
  readonly left_chat_member?: TelegramUser;
}

export interface TelegramCallbackQuery {
  readonly id: string;
  readonly from: TelegramUser;
  readonly message?: TelegramMessage;
  readonly data?: string;
}

export interface TelegramUpdate {
  readonly update_id: number;
  readonly message?: TelegramMessage;
  readonly callback_query?: TelegramCallbackQuery;
}

export interface TelegramFile {
  readonly file_id: string;
  readonly file_size?: number;
  readonly file_path?: string;
}
