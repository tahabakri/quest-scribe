import { setTimeout as delay } from 'node:timers/promises';
import { autoRetry } from '@grammyjs/auto-retry';
import { Bot, GrammyError, HttpError } from 'grammy';
import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';
import type { QuestMatcher } from '../matcher.js';
import type { SheetWriter } from '../writer.js';
import { toTgMessage } from './map.js';
import { TelegramService } from './service.js';
import type { TelegramApiPort } from './types.js';

/** Telegram refused the bot token (revoked, mistyped, or the bot was deleted). Retrying cannot help. */
export class TelegramAuthError extends Error {
  constructor() {
    super('Telegram rejected TELEGRAM_BOT_TOKEN. Create a new token in @BotFather (/token) and update the variable.');
    this.name = 'TelegramAuthError';
  }
}

export interface TelegramAdapterOptions {
  token: string;
  reviewChannelId: string;
  config: Pick<AppConfig, 'quests' | 'replies' | 'telegram' | 'imageExtensions'>;
  matcher: QuestMatcher;
  writer: Pick<SheetWriter, 'record' | 'has'>;
  campaignEnd?: Date | undefined;
  log: Logger;
  /** Called if Telegram stops for good (the token was refused while running). */
  onFatal?: () => void;
  /** Where the Bot API lives. Only tests change this. */
  apiRoot?: string;
  /** Wait before polling again after an unexpected stop. */
  retryDelayMs?: number;
  /** Pauses between tries of a reply or review copy that failed for a passing reason. */
  transientRetryDelaysMs?: readonly number[];
  albumWaitMs?: number;
}

/**
 * Telegram over long polling. A refused token stops it for good and is reported through
 * `onFatal`; an unreachable Telegram or a second copy of the bot polling with the same
 * token is logged and retried.
 */
export class TelegramAdapter {
  private readonly bot: Bot;
  private readonly service: TelegramService;
  private readonly abort = new AbortController();
  private stopped = false;
  private polling: Promise<void> | undefined;

  constructor(private readonly options: TelegramAdapterOptions) {
    this.bot = new Bot(options.token, options.apiRoot === undefined ? {} : { client: { apiRoot: options.apiRoot } });
    // Telegram answers "too many requests" with a wait time: honour it instead of failing the reply.
    // Nothing else is retried by the plugin: by default it would retry a network failure forever with a
    // doubling wait of up to an hour, stalling polling and every reply queued behind it.
    this.bot.api.config.use(
      autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 60, rethrowHttpErrors: true, rethrowInternalServerErrors: true }),
    );
    const retryDelays = options.transientRetryDelaysMs ?? [1000, 3000];
    const again = <T>(call: () => Promise<T>): Promise<T> => withTransientRetries(call, retryDelays, this.abort.signal);

    const api: TelegramApiPort = {
      sendMessage: async (chatId, text) => {
        await again(() => this.bot.api.sendMessage(chatId, text));
      },
      copyToReview: async ({ fromChatId, messageId, caption }) =>
        (await again(() => this.bot.api.copyMessage(options.reviewChannelId, fromChatId, messageId, { caption }))).message_id,
      copyMoreToReview: async ({ fromChatId, messageIds }) => {
        await again(() => this.bot.api.copyMessages(options.reviewChannelId, fromChatId, messageIds));
      },
    };
    this.service = new TelegramService({
      config: options.config,
      matcher: options.matcher,
      writer: options.writer,
      api,
      reviewChannelId: options.reviewChannelId,
      campaignEnd: options.campaignEnd,
      log: options.log,
      albumWaitMs: options.albumWaitMs,
    });

    // Only new messages: edits arrive as edited_message and are never subscribed to.
    this.bot.on('message', async (ctx) => {
      await this.service.handle(
        toTgMessage(ctx.message, { botUsername: ctx.me.username, imageExtensions: options.config.imageExtensions }),
      );
    });
    this.bot.catch((err) => options.log.error('Telegram update failed', { err: err.error }));
  }

  /**
   * Checks the token, checks the review channel, then listens for messages in the
   * background. Throws TelegramAuthError if the token is refused; every other
   * problem is logged and does not stop the bot starting.
   */
  async start(): Promise<{ username: string }> {
    try {
      await this.bot.init();
    } catch (err) {
      if (isUnauthorized(err)) throw new TelegramAuthError();
      throw err;
    }
    const me = this.bot.botInfo;
    await this.checkReviewChannel(me.id);
    await this.bot.api
      .setMyCommands([
        { command: 'start', description: 'How it works' },
        { command: 'help', description: 'How it works, and the quest names' },
      ])
      .catch((err: unknown) => this.options.log.warn('could not set the command menu', { err }));
    this.polling = this.poll();
    return { username: me.username };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.abort.abort();
    await this.bot.stop().catch(() => undefined);
    await this.polling?.catch(() => undefined);
    await this.service.stop();
  }

  private async poll(): Promise<void> {
    const { log } = this.options;
    while (!this.stopped) {
      try {
        // Resolves only when stop() is called. Messages sent while the bot was down are still waiting.
        await this.bot.start({
          allowed_updates: ['message'],
          onStart: (me) => log.info(`listening for Telegram messages as @${me.username}`),
        });
        return;
      } catch (err) {
        if (this.stopped) return;
        if (isUnauthorized(err)) {
          log.error(new TelegramAuthError().message + ' Stopping.');
          this.options.onFatal?.();
          return;
        }
        log.error(
          isConflict(err)
            ? 'another copy of this bot is polling Telegram with the same token; will retry (stop the other copy)'
            : 'Telegram polling stopped unexpectedly; will retry',
          { err },
        );
        await delay(this.options.retryDelayMs ?? 30_000, undefined, { signal: this.abort.signal }).catch(() => undefined);
      }
    }
  }

  private async checkReviewChannel(botId: number): Promise<void> {
    const { log, reviewChannelId } = this.options;
    try {
      const chat = await this.bot.api.getChat(reviewChannelId);
      const member = await this.bot.api.getChatMember(reviewChannelId, botId);
      const canPost =
        member.status === 'creator' || (member.status === 'administrator' && member.can_post_messages !== false);
      const title = 'title' in chat ? chat.title : reviewChannelId;
      if (canPost) log.info(`review channel ready: ${title}`);
      else log.error(`the bot cannot post in the review channel "${title}": add it as an administrator with permission to post messages`);
    } catch (err) {
      log.error('cannot reach the review channel: check TG_REVIEW_CHANNEL_ID, and that the bot was added to it as an administrator', {
        err,
      });
    }
  }
}

/**
 * Tries `call`, and tries again after each pause in `delays` if it failed for a passing
 * reason: the network, or Telegram having a bad moment (5xx). Anything else, such as a
 * member who blocked the bot, fails at once. The wait is bounded, so one stuck reply
 * can never hold up the messages behind it.
 */
export async function withTransientRetries<T>(call: () => Promise<T>, delays: readonly number[], signal?: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (err) {
      const passing = err instanceof HttpError || (err instanceof GrammyError && err.error_code >= 500);
      const wait = delays[attempt];
      if (!passing || wait === undefined || signal?.aborted === true) throw err;
      await delay(wait, undefined, signal === undefined ? {} : { signal }).catch(() => undefined);
    }
  }
}

function isUnauthorized(err: unknown): boolean {
  return err instanceof GrammyError && err.error_code === 401;
}

function isConflict(err: unknown): boolean {
  return err instanceof GrammyError && err.error_code === 409;
}
