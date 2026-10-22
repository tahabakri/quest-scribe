import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';
import type { Logger } from '../src/logger.js';
import { QuestMatcher } from '../src/matcher.js';
import { TelegramAdapter, TelegramAuthError } from '../src/telegram/adapter.js';
import type { WalEntry } from '../src/wal.js';
import { FakeTelegram } from './helpers/fake-telegram.js';

// Fake token, assembled at runtime so secret scanners do not flag the fixture.
const TOKEN = ['123456789', 'AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0'].join(':');
const REVIEW = '-1001234567890';
const USER = 5000;

const config = parseConfig(
  {
    origin: 'test',
    text: `
quests:
  - keyword: share post
    type: share_post
    name: Share Post
  - keyword: boost post
    type: boost_post
    name: Boost Post
replies: { ended: "Season over." }
telegram:
  welcome: "Welcome!"
  link_quest_type: ugc
  replies:
    logged: "Done: {quest}. Cheers!"
    unmatched: "No match. Saved."
    no_caption: "Saved. Add a caption."
    no_image: "Attach a screenshot."
    ugc_logged: "Logged your link."
    error: "Something broke."
`,
  },
  {},
);

function memoryLogger() {
  const lines: { level: string; text: string }[] = [];
  const add = (level: string) => (message: string, fields?: Record<string, unknown>) => {
    const extra = fields ? ' ' + JSON.stringify(fields, (_k, v: unknown) => (v instanceof Error ? `${v.name}: ${v.message}` : v)) : '';
    lines.push({ level, text: message + extra });
  };
  const log: Logger = { debug: add('debug'), info: add('info'), warn: add('warn'), error: add('error'), child: () => log };
  return { log, lines };
}

async function waitFor(condition: () => boolean, what: string, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

let counter = 0;
const base = (chat: Record<string, unknown>, extra: Record<string, unknown>) => ({
  message_id: ++counter + 4000,
  date: Math.floor(new Date('2026-11-01T10:00:00Z').getTime() / 1000),
  chat,
  from: { id: USER, is_bot: false, first_name: 'Sam', username: 'sam_q' },
  ...extra,
});
const dm = (extra: Record<string, unknown>) => base({ id: USER, type: 'private', first_name: 'Sam' }, extra);
const command = (name: string, args = '') =>
  dm({ text: `/${name} ${args}`.trim(), entities: [{ type: 'bot_command', offset: 0, length: name.length + 1 }] });
const photo = (caption: string | undefined, extra: Record<string, unknown> = {}) =>
  dm({ caption, photo: [{ file_id: 'small-id', file_unique_id: 'u1', width: 90, height: 90 }, { file_id: `big-id-${counter + 1}`, file_unique_id: 'u2', width: 1200, height: 1200 }], ...extra });

let fake: FakeTelegram;
let apiRoot: string;
let adapter: TelegramAdapter | undefined;
let recorded: WalEntry[];
let logs: ReturnType<typeof memoryLogger>;

function create(overrides: { token?: string; retryDelayMs?: number; onFatal?: () => void } = {}): TelegramAdapter {
  recorded = [];
  logs = memoryLogger();
  const known = new Set<string>();
  adapter = new TelegramAdapter({
    token: overrides.token ?? TOKEN,
    reviewChannelId: REVIEW,
    config,
    matcher: new QuestMatcher(config.quests, config.fuzzyThreshold),
    writer: {
      has: (id) => known.has(id),
      record: (entry) => {
        if (known.has(entry.id)) return false;
        known.add(entry.id);
        recorded.push(entry);
        return true;
      },
    },
    log: logs.log,
    apiRoot,
    retryDelayMs: overrides.retryDelayMs ?? 50,
    transientRetryDelaysMs: [5, 10],
    albumWaitMs: 120,
    onFatal: overrides.onFatal,
  });
  return adapter;
}
const submissions = () => recorded.filter((e) => e.kind === 'submission').map((e) => e.row);

beforeEach(async () => {
  fake = new FakeTelegram(TOKEN);
  apiRoot = await fake.listen();
});

afterEach(async () => {
  await adapter?.stop();
  adapter = undefined;
  await fake.close();
});

describe('TelegramAdapter against a fake Bot API', () => {
  it('checks the token and the review channel, sets the command menu, and starts listening', async () => {
    const started = await create().start();
    expect(started.username).toBe('quest_test_bot');
    expect(fake.callsOf('getMe')).toHaveLength(1);
    expect(fake.callsOf('getChat')[0]!.payload).toMatchObject({ chat_id: REVIEW });
    expect(fake.callsOf('getChatMember')[0]!.payload).toMatchObject({ chat_id: REVIEW, user_id: 424242 });
    expect(fake.callsOf('setMyCommands')[0]!.payload.commands).toEqual([
      expect.objectContaining({ command: 'start' }),
      expect.objectContaining({ command: 'help' }),
    ]);
    await waitFor(() => fake.callsOf('getUpdates').length > 0, 'polling to start');
    expect(fake.callsOf('getUpdates')[0]!.payload.allowed_updates).toEqual(['message']);
    expect(logs.lines.some((l) => l.text === 'review channel ready: Review Channel')).toBe(true);
  });

  it('runs the whole journey: /start, a screenshot, a link, and chat', async () => {
    await create().start();
    fake.push(command('start', 'quests'));
    fake.push(photo('Share Post ✅'));
    fake.push(dm({ text: 'my write-up https://example.com/post/1' }));
    fake.push(dm({ text: 'hello there' }));
    await waitFor(() => fake.sent.length >= 4, 'four replies');

    expect(fake.sent.map((s) => s.text)).toEqual([
      'Welcome!',
      'Done: Share Post. Cheers!',
      'Logged your link.',
      expect.stringContaining('Quest names') as unknown as string,
    ]);
    expect(fake.sent.every((s) => s.chatId === USER)).toBe(true);

    const [shot, link] = submissions();
    expect(shot).toMatchObject({
      user_id: String(USER),
      username: '@sam_q',
      uid: '',
      bound: false,
      quest_type: 'share_post',
      fuzzy_match: false,
      channel_name: 'telegram_dm',
      message_text: 'Share Post ✅',
      platform: 'telegram',
    });
    // The biggest size of the photo, as a file_id, and a link into the review channel.
    expect(shot!.attachment_url).toMatch(/^big-id-\d+$/);
    expect(shot!.message_link).toBe('https://t.me/c/1234567890/500');
    expect(link).toMatchObject({ quest_type: 'ugc', link_url: 'https://example.com/post/1', message_link: 'https://t.me/c/1234567890/501' });

    const copy = fake.callsOf('copyMessage')[0]!.payload;
    expect(copy).toMatchObject({ chat_id: REVIEW, from_chat_id: USER });
    expect(copy.caption).toContain(`User ${USER} @sam_q | share_post`);
  });

  it('turns an album into one row, copies every photo, and replies once', async () => {
    await create().start();
    const group = { media_group_id: 'album-9' };
    fake.push(photo(undefined, group));
    fake.push(photo('boost post', group));
    fake.push(photo(undefined, group));
    await waitFor(() => fake.sent.length >= 1, 'the album reply');
    await new Promise((resolve) => setTimeout(resolve, 300)); // nothing else may follow

    expect(submissions()).toHaveLength(1);
    expect(submissions()[0]).toMatchObject({ quest_type: 'boost_post', message_text: 'boost post' });
    expect(fake.sent).toHaveLength(1);
    expect(fake.callsOf('copyMessage')).toHaveLength(1);
    expect(fake.callsOf('copyMessages')).toHaveLength(1);
    expect(fake.callsOf('copyMessages')[0]!.payload.message_ids).toHaveLength(2);
  });

  it('treats an image sent as a file like a photo', async () => {
    await create().start();
    fake.push(dm({ caption: 'share post', document: { file_id: 'doc-1', file_unique_id: 'd', file_name: 'shot.png', mime_type: 'image/png' } }));
    await waitFor(() => submissions().length === 1, 'the file submission');
    expect(submissions()[0]).toMatchObject({ attachment_url: 'doc-1', quest_type: 'share_post' });
  });

  it('ignores everything in groups, and from bots and channels', async () => {
    await create().start();
    const group = { id: -100777, type: 'supergroup', title: 'Global' };
    fake.push(base(group, { text: '/bind 123456', entities: [{ type: 'bot_command', offset: 0, length: 5 }] }));
    fake.push(base(group, { text: 'share post' }));
    fake.push(base(group, { caption: 'share post', photo: [{ file_id: 'g', file_unique_id: 'g', width: 1, height: 1 }] }));
    fake.push(dm({ caption: 'share post', photo: [{ file_id: 'b', file_unique_id: 'b', width: 1, height: 1 }], from: { id: 9, is_bot: true, first_name: 'Bot' } }));
    fake.push(command('help')); // a sentinel: once it is answered, everything before it was handled
    await waitFor(() => fake.sent.some((s) => s.text.includes('Quest names')), 'the sentinel reply');

    expect(fake.sent).toHaveLength(1); // only the sentinel
    expect(recorded).toHaveLength(0);
  });

  it('never acts on an edited message', async () => {
    await create().start();
    fake.push(dm({ caption: 'share post', photo: [{ file_id: 'e', file_unique_id: 'e', width: 1, height: 1 }], edit_date: 1 }), 'edited_message');
    fake.push(command('help'));
    await waitFor(() => fake.sent.length >= 1, 'the sentinel reply');
    expect(recorded).toHaveLength(0);
  });

  it('logs a submission once even if Telegram delivers the same message twice', async () => {
    await create().start();
    const m = photo('share post');
    fake.push(m);
    fake.push(m);
    fake.push(command('help'));
    await waitFor(() => fake.sent.some((s) => s.text.includes('Quest names')), 'the sentinel reply');
    expect(submissions()).toHaveLength(1);
    expect(fake.callsOf('copyMessage')).toHaveLength(1);
  });

  it('delivers messages that were waiting while the bot was down', async () => {
    fake.push(photo('share post'));
    fake.push(command('start'));
    await create().start();
    await waitFor(() => fake.sent.length >= 2, 'the backlog to be answered');
    expect(submissions()).toHaveLength(1);
  });

  it('keeps the submission, with a placeholder link, when the bot cannot post to the review channel', async () => {
    await create().start();
    fake.fail('copyMessage', 400, 'Bad Request: chat not found');
    fake.push(photo('share post'));
    await waitFor(() => submissions().length === 1, 'the submission');
    expect(submissions()[0]!.message_link).toMatch(/^tg-dm:5000\/\d+$/);
    expect(logs.lines.some((l) => l.level === 'error' && /review channel/.test(l.text))).toBe(true);
    await waitFor(() => fake.sent.length === 1, 'the reply');
  });

  it('says so in the log when the bot is not an admin of the review channel', async () => {
    fake.botCanPost = false;
    await create().start();
    expect(logs.lines.some((l) => l.level === 'error' && /cannot post in the review channel/.test(l.text))).toBe(true);
  });

  it('survives a reply that Telegram refuses, such as a member who blocked the bot', async () => {
    await create().start();
    fake.fail('sendMessage', 403, 'Forbidden: bot was blocked by the user');
    fake.push(photo('share post'));
    fake.push(command('help'));
    await waitFor(() => fake.sent.some((s) => s.text.includes('Quest names')), 'later messages to still be answered');
    expect(submissions()).toHaveLength(1);
    expect(logs.lines.some((l) => l.level === 'warn' && /could not send a reply/.test(l.text))).toBe(true);
  });
});

describe('TelegramAdapter failure handling', () => {
  it('refuses a rejected token with a clear error that does not contain the token', async () => {
    const wrong = ['987654321', 'AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawZ'].join(':');
    const bad = create({ token: wrong });
    let error: unknown;
    try {
      await bad.start();
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(TelegramAuthError);
    expect((error as Error).message).toMatch(/@BotFather/);
    expect((error as Error).message).not.toContain(wrong);
  });

  it('keeps retrying when another copy of the bot is polling (409), and recovers when it stops', async () => {
    fake.fail('getUpdates', 409, 'Conflict: terminated by other getUpdates request', 2);
    await create({ retryDelayMs: 30 }).start();
    await waitFor(() => logs.lines.some((l) => /another copy of this bot is polling/.test(l.text)), 'the conflict to be reported');
    fake.push(command('help'));
    await waitFor(() => fake.sent.length >= 1, 'a reply after the conflict cleared');
    expect(logs.lines.filter((l) => /another copy/.test(l.text)).length).toBeGreaterThanOrEqual(1);
  });

  it('turns Telegram off for good, and says so, if the token is revoked while running', async () => {
    let fatal = 0;
    fake.fail('getUpdates', 401, 'Unauthorized', 1);
    await create({ onFatal: () => fatal++ }).start();
    await waitFor(() => fatal === 1, 'the fatal callback');
    expect(logs.lines.some((l) => l.level === 'error' && /rejected TELEGRAM_BOT_TOKEN/.test(l.text))).toBe(true);
  });

  it('retries a reply once or twice after a dropped connection, so a blip does not lose it', async () => {
    await create().start();
    fake.drop('sendMessage', 2);
    fake.push(command('start'));
    await waitFor(() => fake.sent.length === 1, 'the reply to arrive after two lost connections');
    expect(fake.sent[0]!.text).toBe('Welcome!');
    expect(fake.callsOf('sendMessage')).toHaveLength(3);
  });

  it('retries a reply after Telegram has a bad moment (5xx) too', async () => {
    await create().start();
    fake.fail('sendMessage', 502, 'Bad Gateway', 1);
    fake.push(command('start'));
    await waitFor(() => fake.sent.length === 1, 'the reply after the 502');
    expect(fake.callsOf('sendMessage')).toHaveLength(2);
  });

  it('gives up on a reply after a few tries and carries on: a stuck reply never blocks the queue', async () => {
    await create().start();
    fake.drop('sendMessage', 3); // the first reply fails its initial try and both retries
    fake.push(photo('share post'));
    fake.push(command('start'));
    await waitFor(() => fake.sent.some((s) => s.text === 'Welcome!'), 'the next message to be answered');
    expect(submissions()).toHaveLength(1); // the row was saved even though its reply was lost
    expect(logs.lines.some((l) => l.level === 'warn' && /could not send a reply/.test(l.text))).toBe(true);
  });

  it('does not retry a refusal that retrying cannot fix (a member who blocked the bot)', async () => {
    await create().start();
    fake.fail('sendMessage', 403, 'Forbidden: bot was blocked by the user', 1);
    fake.push(command('start'));
    fake.push(command('help'));
    await waitFor(() => fake.sent.some((s) => s.text.includes('Quest names')), 'the next reply');
    expect(fake.callsOf('sendMessage')).toHaveLength(2); // one refused (not retried), one delivered
  });

  it('still saves the submission, with a placeholder link, when the review copy keeps failing', async () => {
    await create().start();
    fake.drop('copyMessage', 3);
    fake.push(photo('share post'));
    await waitFor(() => submissions().length === 1, 'the submission');
    expect(submissions()[0]!.message_link).toMatch(/^tg-dm:5000\/\d+$/);
    expect(fake.callsOf('copyMessage')).toHaveLength(3);
  });

  it('never lets the bot token reach a log line or a row, whatever fails', async () => {
    await create({ retryDelayMs: 30 }).start();
    fake.drop('sendMessage', 3);
    fake.drop('copyMessage', 3);
    fake.fail('copyMessage', 500, 'Internal Server Error', 0);
    fake.fail('getUpdates', 500, 'Internal Server Error', 1);
    fake.fail('sendMessage', 403, 'Forbidden: bot was blocked by the user', 1);
    fake.push(photo('share post'));
    fake.push(command('help'));
    fake.push(command('start'));
    await waitFor(() => submissions().length === 1, 'the submission');
    await waitFor(() => fake.callsOf('sendMessage').length >= 5, 'the replies to be attempted');
    await new Promise((resolve) => setTimeout(resolve, 200));
    const everything = JSON.stringify(logs.lines);
    expect(everything).not.toContain(TOKEN);
    expect(everything).not.toContain(TOKEN.split(':')[1]!);
    expect(JSON.stringify(recorded)).not.toContain(TOKEN);
    expect(logs.lines.length).toBeGreaterThan(3);
  });

  it('finishes an album that is still being collected when the bot is stopped', async () => {
    const a = create();
    await a.start();
    fake.push(photo('share post', { media_group_id: 'late-album' }));
    fake.push(photo(undefined, { media_group_id: 'late-album' }));
    await waitFor(() => fake.pendingUpdates > 0 || fake.callsOf('getUpdates').length > 1, 'the album to arrive');
    await new Promise((resolve) => setTimeout(resolve, 60)); // arrived, still inside the album wait
    await a.stop();
    expect(submissions()).toHaveLength(1);
  });
});
