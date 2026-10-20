import type { Message } from 'grammy/types';
import { isImageAttachment } from '../submissions.js';
import { parseCommand } from './parse.js';
import type { TgEntity, TgImage, TgMessage } from './types.js';

/**
 * Turns a Telegram message into the bot's own small model. A photo, or a file whose
 * type or name says it is an image (png, jpg, jpeg, gif, webp by default), counts as
 * an image; anything else (video, voice, sticker, a PDF) does not.
 */
export function toTgMessage(
  message: Message,
  options: { botUsername?: string | undefined; imageExtensions: readonly string[] },
): TgMessage {
  const entities: TgEntity[] = (message.entities ?? message.caption_entities ?? []).map((e) => ({
    type: e.type,
    offset: e.offset,
    length: e.length,
    url: 'url' in e ? e.url : undefined,
  }));

  // A command only counts at the very start of the message, as Telegram marks it.
  const startsWithCommand = entities.some((e) => e.type === 'bot_command' && e.offset === 0);
  const from = message.from;

  return {
    chatId: message.chat.id,
    chatType: message.chat.type,
    messageId: message.message_id,
    date: new Date(message.date * 1000),
    fromId: from?.id,
    fromIsBot: from?.is_bot ?? false,
    username: from === undefined ? '' : from.username !== undefined ? `@${from.username}` : from.first_name,
    text: message.text,
    caption: message.caption,
    entities,
    command: startsWithCommand ? parseCommand(message.text, options.botUsername) : undefined,
    images: imagesOf(message, options.imageExtensions),
    mediaGroupId: message.media_group_id,
  };
}

function imagesOf(message: Message, extensions: readonly string[]): TgImage[] {
  // Telegram lists a photo's sizes smallest first; the last is the original.
  const photo = message.photo?.at(-1);
  if (photo !== undefined) return [{ fileId: photo.file_id, messageId: message.message_id }];
  const file = message.document;
  if (
    file !== undefined &&
    isImageAttachment({ name: file.file_name ?? '', url: '', contentType: file.mime_type ?? null }, extensions)
  ) {
    return [{ fileId: file.file_id, messageId: message.message_id }];
  }
  return [];
}
