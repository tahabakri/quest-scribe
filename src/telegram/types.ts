/** A Telegram message reduced to what the bot acts on. Built by map.ts; the service never sees grammY types. */
export interface TgEntity {
  type: string;
  offset: number;
  length: number;
  /** For "text_link" entities: the URL hidden behind the text. */
  url?: string | undefined;
}

export interface TgImage {
  /** Telegram's id for the file. Bot-specific and safe to store; never turn it into a download URL. */
  fileId: string;
  messageId: number;
}

export interface TgCommand {
  /** Lower-case, without the slash or the @botname. */
  name: string;
  args: string;
}

export interface TgMessage {
  chatId: number;
  chatType: 'private' | 'group' | 'supergroup' | 'channel';
  messageId: number;
  /** When the member sent it. */
  date: Date;
  fromId: number | undefined;
  fromIsBot: boolean;
  /** "@handle", or the first name when the member has no handle. */
  username: string;
  text: string | undefined;
  caption: string | undefined;
  /** Entities of the text, or of the caption when there is no text. */
  entities: TgEntity[];
  command: TgCommand | undefined;
  /** One image for a photo or an image sent as a file; empty for everything else. */
  images: TgImage[];
  /** Messages of one album share this. */
  mediaGroupId: string | undefined;
}

/** What the service needs from Telegram. grammY implements it in adapter.ts; tests fake it. */
export interface TelegramApiPort {
  sendMessage(chatId: number, text: string): Promise<void>;
  /** Copies a message into the review channel, with a new caption. Returns the copy's message id. */
  copyToReview(args: { fromChatId: number; messageId: number; caption: string }): Promise<number>;
  /** Copies further messages (the rest of an album) into the review channel, keeping their captions. */
  copyMoreToReview(args: { fromChatId: number; messageIds: number[] }): Promise<void>;
}
