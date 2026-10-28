import { hasEnded } from '../campaign.js';
import type { AppConfig } from '../config.js';
import { type Logger } from '../logger.js';
import type { QuestMatcher } from '../matcher.js';
import { buildHelpText, questNameFor } from '../quests.js';
import type { SubmissionRow } from '../sheets/schema.js';
import { buildSubmissionRow, classifyImageMessage } from '../submissions.js';
import type { SheetWriter } from '../writer.js';
import { AlbumCollector } from './albums.js';
import { firstLinkIn } from './parse.js';
import type { TelegramApiPort, TgMessage } from './types.js';

/** What the sheet's channel_name column says for a submission sent to the bot in a private chat... */
export const TELEGRAM_CHANNEL_NAME = 'telegram_dm';
/** ...and for one posted in the community group. */
export const TELEGRAM_GROUP_CHANNEL_NAME = 'telegram_group';

const CAPTION_LIMIT = 1024;

export interface TelegramServiceDeps {
  config: Pick<AppConfig, 'quests' | 'replies' | 'telegram'>;
  matcher: QuestMatcher;
  writer: Pick<SheetWriter, 'record' | 'has'>;
  api: TelegramApiPort;
  /**
   * The private channel's ID as Telegram gives it: -100 followed by digits. Without one,
   * a post in the group is linked in place and a private chat is asked to post in the group.
   */
  reviewChannelId?: string | undefined;
  /** After this moment submissions are answered, not logged. */
  campaignEnd?: Date | undefined;
  /** Groups where submissions are posted in the group itself. Any other group is ignored. */
  groupIds?: readonly number[] | undefined;
  log: Logger;
  /** How long to wait for the rest of an album. */
  albumWaitMs?: number;
}

/**
 * Everything the bot does on Telegram, one message at a time. Talks to Telegram
 * only through `api`, so it can be tested without the network, and never throws:
 * a bad message is logged and answered, it cannot stop the bot.
 *
 * Members submit in a private chat with the bot, or in the community group(s) named in
 * `groupIds`, where the bot reacts only to photos (and to a quest name without a photo) and
 * stays silent on ordinary chat. Any other group is ignored. There is no /bind
 * here: members link their account ID once in the separate campaign bot, which this
 * bot cannot see, so every row it writes has uid blank and bound = FALSE.
 */
export class TelegramService {
  private readonly albums: AlbumCollector;
  private readonly helpText: string;
  private readonly groups: ReadonlySet<number>;

  constructor(private readonly deps: TelegramServiceDeps) {
    const { config } = deps;
    this.groups = new Set(deps.groupIds ?? []);
    this.helpText = buildHelpText(config.telegram.welcome, config.telegram.helpQuestsHeading, config.quests);
    this.albums = new AlbumCollector(
      (parts) => this.safely(parts[0]?.chatId, () => this.submitImages(parts)),
      deps.albumWaitMs,
    );
  }

  async handle(message: TgMessage): Promise<void> {
    await this.safely(message.chatId, () => this.route(message));
  }

  /** Finishes albums still waiting for their last photo. Call at shutdown. */
  async stop(): Promise<void> {
    await this.albums.flushAll();
  }

  private async route(message: TgMessage): Promise<void> {
    if (message.fromIsBot || message.fromId === undefined) return;
    const { telegram } = this.deps.config;

    if (message.chatType !== 'private') return this.groupMessage(message);

    const command = message.command;
    // Once the campaign is over nobody is invited to submit: the instructions would only lead to "ended".
    if (command?.name === 'start') return this.say(message.chatId, this.ended(message) ? this.deps.config.replies.ended : telegram.welcome);
    if (command?.name === 'help') return this.say(message.chatId, this.ended(message) ? this.deps.config.replies.ended : this.helpText);

    // No review channel means no way to keep evidence from a private chat: submissions are taken in the group.
    if (this.deps.reviewChannelId === undefined) {
      return this.say(message.chatId, this.ended(message) ? this.deps.config.replies.ended : telegram.replies.useGroup);
    }

    if (message.images.length > 0) {
      if (message.mediaGroupId === undefined) await this.submitImages([message]);
      else if (this.albums.add(message) === 'late') await this.copyLatePart(message);
      return;
    }
    return this.textMessage(message);
  }

  /**
   * A message in the community group. Only the configured group counts, and the bot is quiet
   * unless the member is clearly submitting: a photo, or a quest name without a photo. Chat,
   * commands and links on their own are left alone, so the group stays readable.
   */
  private async groupMessage(message: TgMessage): Promise<void> {
    if (message.chatType === 'channel' || !this.groups.has(message.chatId)) return;
    if (message.images.length > 0) {
      if (message.mediaGroupId === undefined) await this.submitImages([message]);
      else if (this.albums.add(message) === 'late') await this.copyLatePart(message);
      return;
    }
    const text = message.text ?? '';
    if (message.command !== undefined || this.deps.matcher.match(text).kind === 'none') return;
    if (this.ended(message)) return this.say(message.chatId, this.deps.config.replies.ended, message.messageId);
    await this.say(message.chatId, this.deps.config.telegram.replies.noImage, message.messageId);
  }

  /** A message with no image: a link is a content submission, a quest name alone is a reminder, anything else gets help. */
  private async textMessage(message: TgMessage): Promise<void> {
    const { config, matcher } = this.deps;
    const text = message.text ?? message.caption ?? '';
    const link = firstLinkIn(text, message.entities);

    if (this.ended(message)) return this.say(message.chatId, config.replies.ended);
    if (link === undefined && matcher.match(text).kind === 'none') return this.say(message.chatId, this.helpText);
    if (link === undefined) {
      return this.say(message.chatId, config.telegram.replies.noImage);
    }
    await this.submitLink(message, text, link);
  }

  private async submitLink(message: TgMessage, text: string, link: string): Promise<void> {
    const { config } = this.deps;
    const questType = config.telegram.linkQuestType;
    const id = `tg:sub:${message.chatId}:${message.messageId}`;
    if (this.deps.writer.has(id)) return; // delivered twice

    const messageLink = await this.copyToReview(message, [message.messageId], {
      questType,
      fuzzy: false,
      text,
    });
    const row = buildSubmissionRow(
      {
        createdAt: message.date,
        authorId: String(message.fromId),
        authorUsername: message.username,
        channelName: channelNameOf(message),
        content: text,
        url: messageLink,
      },
      { platform: 'telegram', questType, fuzzy: false, attachmentUrl: '', linkUrl: link },
    );
    if (!this.record(message.chatId, id, row)) return await this.say(message.chatId, config.telegram.replies.error);
    await this.say(message.chatId, config.telegram.replies.ugcLogged);
  }

  /**
   * A photo of an album that arrived after the album was logged. It is not a submission of
   * its own, so there is no second row and no second reply; it only goes to the reviewers,
   * so the evidence is not lost.
   */
  private async copyLatePart(message: TgMessage): Promise<void> {
    if (this.ended(message) || this.deps.reviewChannelId === undefined) return;
    const { api, log } = this.deps;
    log.info('a photo arrived after its album was logged; copying it to the review channel only', { chat: message.chatId });
    await api.copyMoreToReview({ fromChatId: message.chatId, messageIds: [message.messageId] }).catch((err: unknown) => {
      log.warn('could not copy a late album photo to the review channel', { err });
    });
  }

  /** One or more photos from one member become one submission: the caption may sit on any of them. */
  private async submitImages(parts: TgMessage[]): Promise<void> {
    const { config, matcher } = this.deps;
    const first = parts[0];
    if (first === undefined) return;
    const captioned = parts.find((p) => (p.caption ?? '').trim() !== '');
    const caption = captioned?.caption ?? '';

    const replyTo = first.chatType === 'private' ? undefined : first.messageId;
    if (this.ended(first)) return this.say(first.chatId, config.replies.ended, replyTo);

    const outcome = classifyImageMessage({ text: caption, hasImage: true }, matcher);
    if (outcome.action !== 'log') return;
    const id = `tg:sub:${first.chatId}:${first.messageId}`;
    if (this.deps.writer.has(id)) return; // delivered twice

    const messageIds = parts.map((p) => p.messageId);
    const messageLink = await this.copyToReview(first, messageIds, {
      questType: outcome.questType,
      fuzzy: outcome.fuzzy,
      text: caption,
    });
    const fileId = first.images[0]?.fileId ?? '';
    const row = buildSubmissionRow(
      {
        createdAt: first.date,
        authorId: String(first.fromId),
        authorUsername: first.username,
        channelName: channelNameOf(first),
        content: caption,
        url: messageLink,
      },
      {
        platform: 'telegram',
        questType: outcome.questType,
        fuzzy: outcome.fuzzy,
        // The file_id, never a download URL: that would contain the bot token.
        attachmentUrl: fileId,
        ...(captioned ? { linkUrl: firstLinkIn(caption, captioned.entities) ?? '' } : {}),
      },
    );
    if (!this.record(first.chatId, id, row)) return await this.say(first.chatId, config.telegram.replies.error, replyTo);

    const { replies } = config.telegram;
    const text =
      caption.trim() === ''
        ? replies.noCaption
        : outcome.reaction === 'success'
          ? replies.logged.replaceAll('{quest}', questNameFor(config.quests, outcome.questType))
          : replies.unmatched;
    await this.say(first.chatId, text, replyTo);
  }

  /**
   * Makes the row durable before anything is promised. Returns false, after telling
   * the log loudly, if it could not: the member is then told to try again.
   */
  private record(chatId: number, id: string, row: SubmissionRow): boolean {
    try {
      this.deps.writer.record({ id, kind: 'submission', row });
      this.deps.log.info('submission logged', {
        platform: 'telegram',
        chat: chatId,
        user: row.user_id,
        questType: row.quest_type,
        fuzzy: row.fuzzy_match,
      });
      return true;
    } catch (err) {
      // Last resort: the row goes to the host's logs so it can be recovered by hand.
      this.deps.log.error('SUBMISSION NOT SAVED: write-ahead log failed', { err, row: JSON.stringify(row) });
      return false;
    }
  }

  /**
   * Copies the submission into the private review channel and returns the link to the
   * copy. If the copy fails the submission is still logged: the row then carries a
   * placeholder that can't be opened but is unique per message, and the file_id still
   * identifies the evidence.
   */
  private async copyToReview(
    message: TgMessage,
    messageIds: number[],
    info: { questType: string; fuzzy: boolean; text: string },
  ): Promise<string> {
    const { api, log, reviewChannelId } = this.deps;
    const [firstId, ...rest] = messageIds;
    const fallback = `tg-dm:${message.chatId}/${firstId ?? message.messageId}`;
    if (firstId === undefined) return fallback;
    // No review channel: the member's own post in the group is the evidence, so link to it.
    if (reviewChannelId === undefined) return groupPostLink(message.chatId, firstId);
    try {
      const copied = await api.copyToReview({
        fromChatId: message.chatId,
        messageId: firstId,
        caption: reviewCaption({ ...info, userId: String(message.fromId), username: message.username }),
      });
      if (rest.length > 0) {
        await api.copyMoreToReview({ fromChatId: message.chatId, messageIds: rest }).catch((err: unknown) => {
          log.warn('could not copy the rest of an album to the review channel', { err });
        });
      }
      return copied > 0 ? reviewLink(reviewChannelId, copied) : fallback;
    } catch (err) {
      log.error('could not copy a submission to the review channel (is the bot an admin there?)', { err });
      return fallback;
    }
  }

  private ended(message: TgMessage): boolean {
    return hasEnded(this.deps.campaignEnd, message.date);
  }

  private async say(chatId: number, text: string, replyTo?: number): Promise<void> {
    try {
      await this.deps.api.sendMessage(chatId, text, replyTo);
    } catch (err) {
      // For example the member blocked the bot. The row, if any, is already saved.
      this.deps.log.warn('could not send a reply', { chat: chatId, err });
    }
  }

  private async safely(chatId: number | undefined, work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (err) {
      this.deps.log.error('Telegram handler failed', { err });
      if (chatId !== undefined) await this.say(chatId, this.deps.config.telegram.replies.error);
    }
  }
}

function channelNameOf(message: TgMessage): string {
  return message.chatType === 'private' ? TELEGRAM_CHANNEL_NAME : TELEGRAM_GROUP_CHANNEL_NAME;
}

/** t.me/c/<channel>/<message>: a private channel's ID minus its -100 prefix. */
export function reviewLink(channelId: string, messageId: number): string {
  return `https://t.me/c/${channelId.replace(/^-100/, '')}/${messageId}`;
}

/** t.me/c/<group>/<message>: a supergroup's ID minus its -100 prefix. Opens for anyone who is in the group. */
export function groupPostLink(chatId: number, messageId: number): string {
  return `https://t.me/c/${String(chatId).replace(/^-100/, '')}/${messageId}`;
}

/** What the review channel shows next to a copied submission. */
export function reviewCaption(info: {
  userId: string;
  username: string;
  questType: string;
  fuzzy: boolean;
  text: string;
}): string {
  const head = `User ${info.userId} ${info.username} | ${info.questType}${info.fuzzy ? ' (flagged for review)' : ''}`;
  const text = info.text.trim();
  const full = text === '' ? head : `${head}\n\n${text}`;
  return full.length <= CAPTION_LIMIT ? full : `${full.slice(0, CAPTION_LIMIT - 1)}…`;
}
