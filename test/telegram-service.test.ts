import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../src/config.js';
import type { Logger } from '../src/logger.js';
import { QuestMatcher } from '../src/matcher.js';
import { TELEGRAM_CHANNEL_NAME, TelegramService, reviewCaption, reviewLink } from '../src/telegram/service.js';
import type { TelegramApiPort, TgEntity, TgMessage } from '../src/telegram/types.js';
import type { WalEntry } from '../src/wal.js';

const REVIEW_CHANNEL = '-1001234567890';
const USER = 5000;

const config = parseConfig(
  {
    origin: 'test',
    text: `
quests:
  - keyword: share post
    type: share_post
    name: Share Post
  - keyword: sharing post
    type: share_post
    review: true
  - keyword: boost post
    type: boost_post
    name: Boost Post
  - keyword: join
    type: event_join
    strict: true
    name: Event Join
  - keyword: join event
    type: event_join
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
  const lines: { level: string; message: string; fields?: unknown }[] = [];
  const log: Logger = {
    debug: () => {},
    info: (message, fields) => lines.push({ level: 'info', message, fields }),
    warn: (message, fields) => lines.push({ level: 'warn', message, fields }),
    error: (message, fields) => lines.push({ level: 'error', message, fields }),
    child: () => log,
  };
  return { log, lines };
}

interface Options {
  end?: Date;
  groups?: number[];
  record?: (entry: WalEntry) => boolean;
  copy?: (args: { fromChatId: number; messageId: number; caption: string }) => Promise<number>;
  copyMore?: (args: { fromChatId: number; messageIds: number[] }) => Promise<void>;
  send?: (chatId: number, text: string) => Promise<void>;
  matcher?: QuestMatcher;
}

function setup(options: Options = {}) {
  const sent: { chatId: number; text: string; replyTo?: number }[] = [];
  const copies: { fromChatId: number; messageId: number; caption: string }[] = [];
  const more: { fromChatId: number; messageIds: number[] }[] = [];
  const recorded: WalEntry[] = [];
  const known = new Set<string>();
  let reviewId = 700;
  const api: TelegramApiPort = {
    sendMessage: async (chatId, text, replyTo) => {
      if (options.send) await options.send(chatId, text);
      sent.push(replyTo === undefined ? { chatId, text } : { chatId, text, replyTo });
    },
    copyToReview: async (args) => {
      copies.push(args);
      return options.copy ? options.copy(args) : ++reviewId;
    },
    copyMoreToReview: async (args) => {
      more.push(args);
      await options.copyMore?.(args);
    },
  };
  const { log, lines } = memoryLogger();
  const service = new TelegramService({
    config,
    matcher: options.matcher ?? new QuestMatcher(config.quests, config.fuzzyThreshold),
    writer: {
      has: (id) => known.has(id),
      record: (entry) => {
        if (options.record) return options.record(entry);
        if (known.has(entry.id)) return false;
        known.add(entry.id);
        recorded.push(entry);
        return true;
      },
    },
    api,
    reviewChannelId: REVIEW_CHANNEL,
    campaignEnd: options.end,
    groupIds: options.groups,
    log,
    albumWaitMs: 1000,
  });
  const submissions = () => recorded.filter((e) => e.kind === 'submission').map((e) => e.row);
  const replies = () => sent.map((s) => s.text);
  return { service, sent, copies, more, recorded, submissions, replies, lines };
}

let seq = 0;
function msg(overrides: Partial<TgMessage> = {}): TgMessage {
  const messageId = overrides.messageId ?? ++seq + 1000;
  return {
    chatId: USER,
    chatType: 'private',
    messageId,
    date: new Date('2026-11-01T10:00:00Z'),
    fromId: USER,
    fromIsBot: false,
    username: '@member',
    text: undefined,
    caption: undefined,
    entities: [],
    command: undefined,
    images: [],
    mediaGroupId: undefined,
    ...overrides,
  };
}
const photo = (caption?: string, overrides: Partial<TgMessage> = {}): TgMessage => {
  const messageId = overrides.messageId ?? ++seq + 1000;
  return msg({ messageId, caption, images: [{ fileId: `FILE-${messageId}`, messageId }], ...overrides });
};
const text = (value: string, overrides: Partial<TgMessage> = {}): TgMessage => msg({ text: value, ...overrides });
const command = (name: string, args = '', overrides: Partial<TgMessage> = {}): TgMessage =>
  msg({ text: `/${name} ${args}`.trim(), command: { name, args }, ...overrides });

afterEach(() => {
  vi.useRealTimers();
});

describe('/start and /help', () => {
  it('/start sends the welcome text', async () => {
    const t = setup();
    await t.service.handle(command('start'));
    await t.service.handle(command('start', 'quests')); // the deep link payload
    expect(t.replies()).toEqual(['Welcome!', 'Welcome!']);
  });

  it('/help adds the quest names: the first keyword of each quest that is not a close variant, in config order', async () => {
    const t = setup();
    await t.service.handle(command('help'));
    expect(t.replies()).toEqual(['Welcome!\n\nQuest names, to use as the caption:\n- share post\n- boost post\n- join']);
  });

  it('plain text with no link and no quest name also gets the help text, and logs nothing', async () => {
    const t = setup();
    await t.service.handle(text('hello there'));
    expect(t.replies()[0]).toContain('Quest names');
    expect(t.recorded).toHaveLength(0);
  });
});

describe('no binding on Telegram', () => {
  it('has no /bind: it saves nothing and answers with the help text', async () => {
    const t = setup();
    await t.service.handle(command('bind', '123456'));
    expect(t.recorded).toHaveLength(0);
    expect(t.replies()).toHaveLength(1);
    expect(t.replies()[0]).toContain('Quest names');
  });

  it('ignores /bind in a group too', async () => {
    const t = setup();
    await t.service.handle(command('bind', '123456', { chatId: -100999, chatType: 'supergroup' }));
    expect(t.recorded).toHaveLength(0);
    expect(t.sent).toHaveLength(0);
  });

  it('writes uid blank and bound = FALSE on every row, with the Telegram user ID in user_id, and never reminds anyone to bind', async () => {
    const t = setup();
    await t.service.handle(photo('share post'));
    await t.service.handle(photo('look at my setup'));
    await t.service.handle(photo(undefined));
    await t.service.handle(text('my post https://example.com/p'));
    expect(t.submissions()).toHaveLength(4);
    for (const row of t.submissions()) {
      expect(row).toMatchObject({ uid: '', bound: false, user_id: String(USER), platform: 'telegram' });
    }
    expect(t.replies().join(' ')).not.toMatch(/bind/i);
    expect(t.copies.every((c) => !c.caption.includes('UID'))).toBe(true);
  });
});

describe('posting in the community group', () => {
  const GROUP = -100555;
  const inGroup = (overrides: Partial<TgMessage> = {}): Partial<TgMessage> => ({ chatId: GROUP, chatType: 'supergroup', ...overrides });

  it('logs a photo posted in the group, as a group submission, and replies to that message', async () => {
    const t = setup({ groups: [GROUP] });
    const m = photo('share post', inGroup());
    await t.service.handle(m);
    expect(t.submissions()).toHaveLength(1);
    expect(t.submissions()[0]).toMatchObject({ quest_type: 'share_post', channel_name: 'telegram_group', uid: '', bound: false, platform: 'telegram' });
    expect(t.sent).toEqual([{ chatId: GROUP, text: 'Done: Share Post. Cheers!', replyTo: m.messageId }]);
    expect(t.copies[0]).toMatchObject({ fromChatId: GROUP, messageId: m.messageId });
  });

  it('is silent on ordinary chat, commands and links on their own', async () => {
    const t = setup({ groups: [GROUP] });
    await t.service.handle(text('good morning everyone', inGroup()));
    await t.service.handle(text('check this https://example.com/x', inGroup()));
    await t.service.handle(command('help', '', inGroup()));
    await t.service.handle(command('start', '', inGroup()));
    expect(t.sent).toHaveLength(0);
    expect(t.recorded).toHaveLength(0);
  });

  it('reminds a member who names a quest without a photo, replying to them', async () => {
    const t = setup({ groups: [GROUP] });
    const m = text('I did the share post', inGroup());
    await t.service.handle(m);
    expect(t.sent).toEqual([{ chatId: GROUP, text: 'Attach a screenshot.', replyTo: m.messageId }]);
  });

  it('ignores every other group, and channels', async () => {
    const t = setup({ groups: [GROUP] });
    await t.service.handle(photo('share post', { chatId: -100999, chatType: 'supergroup' }));
    await t.service.handle(photo('share post', { chatId: GROUP, chatType: 'channel' }));
    expect(t.recorded).toHaveLength(0);
    expect(t.sent).toHaveLength(0);
  });

  it('ignores groups entirely when none is configured', async () => {
    const t = setup();
    await t.service.handle(photo('share post', inGroup()));
    expect(t.recorded).toHaveLength(0);
  });

  it('gathers an album posted in the group into one row and one reply', async () => {
    vi.useFakeTimers();
    const t = setup({ groups: [GROUP] });
    await t.service.handle(photo('boost post', inGroup({ messageId: 5001, mediaGroupId: 'ga' })));
    await t.service.handle(photo(undefined, inGroup({ messageId: 5002, mediaGroupId: 'ga' })));
    await vi.advanceTimersByTimeAsync(2500);
    expect(t.submissions()).toHaveLength(1);
    expect(t.sent).toEqual([{ chatId: GROUP, text: 'Done: Boost Post. Cheers!', replyTo: 5001 }]);
  });

  it('answers with the ended message after the campaign, only to submissions', async () => {
    const t = setup({ groups: [GROUP], end: new Date('2026-11-22T23:59:59Z') });
    const late = new Date('2026-11-23T00:00:00Z');
    await t.service.handle(photo('share post', inGroup({ date: late })));
    await t.service.handle(text('hello', inGroup({ date: late })));
    expect(t.sent.map((s) => s.text)).toEqual(['Season over.']);
    expect(t.recorded).toHaveLength(0);
  });
});

describe('what the bot ignores', () => {
  it.each([
    ['text in a group', text('share post', { chatId: -100999, chatType: 'group' })],
    ['a photo in a group', photo('share post', { chatId: -100999, chatType: 'supergroup' })],
    ['a link in a group', text('https://example.com/x', { chatId: -100999, chatType: 'group' })],
    ['/start in a group', command('start', '', { chatId: -100999, chatType: 'group' })],
    ['a channel post', text('share post', { chatType: 'channel', fromId: undefined })],
    ['a message from a bot', photo('share post', { fromIsBot: true })],
    ['a message with no sender', photo('share post', { fromId: undefined })],
  ])('%s', async (_label, message) => {
    const t = setup();
    await t.service.handle(message);
    expect(t.sent).toHaveLength(0);
    expect(t.recorded).toHaveLength(0);
    expect(t.copies).toHaveLength(0);
  });
});

describe('image submissions', () => {
  it('logs a photo with a quest caption, copies it for review, and says what was logged', async () => {
    const t = setup();
    const m = photo('Share Post ✅');
    await t.service.handle(m);

    expect(t.submissions()).toEqual([
      {
        timestamp_utc: '2026-11-01T10:00:00Z',
        user_id: String(USER),
        username: '@member',
        uid: '',
        bound: false,
        quest_type: 'share_post',
        fuzzy_match: false,
        channel_name: TELEGRAM_CHANNEL_NAME,
        message_text: 'Share Post ✅',
        attachment_url: `FILE-${m.messageId}`,
        link_url: '',
        message_link: 'https://t.me/c/1234567890/701',
        date_utc: '2026-11-01',
        platform: 'telegram',
      },
    ]);
    expect(t.recorded[0]!.id).toBe(`tg:sub:${USER}:${m.messageId}`);
    expect(t.copies).toEqual([
      { fromChatId: USER, messageId: m.messageId, caption: `User ${USER} @member | share_post\n\nShare Post ✅` },
    ]);
    expect(t.replies()).toEqual(['Done: Share Post. Cheers!']);
  });

  it('never stores a download URL: attachment_url is the bare file_id, and the token appears nowhere', async () => {
    const t = setup();
    await t.service.handle(photo('share post'));
    const row = t.submissions()[0]!;
    expect(row.attachment_url).toMatch(/^FILE-\d+$/);
    expect(JSON.stringify(t.recorded)).not.toMatch(/api\.telegram\.org|https?:\/\/[^"]*bot\d/);
  });

  it('keeps a specific quest from being logged as a sibling that shares a word', async () => {
    const t = setup();
    await t.service.handle(photo('boost post'));
    expect(t.submissions()[0]).toMatchObject({ quest_type: 'boost_post', fuzzy_match: false });
  });

  it('flags a typo for review (fuzzy_match = TRUE) and still logs it as that quest', async () => {
    const t = setup();
    await t.service.handle(photo('share pst'));
    expect(t.submissions()[0]).toMatchObject({ quest_type: 'share_post', fuzzy_match: true });
    expect(t.replies()[0]).toMatch(/^Done: Share Post\./);
    expect(t.copies[0]!.caption).toContain('(flagged for review)');
  });

  it('flags a close variant of the official caption the same way', async () => {
    const t = setup();
    await t.service.handle(photo('sharing post'));
    expect(t.submissions()[0]).toMatchObject({ quest_type: 'share_post', fuzzy_match: true });
  });

  it('logs a caption that matches nothing as unmatched, keeps the raw text, and says it was saved', async () => {
    const t = setup();
    await t.service.handle(photo('look at my setup'));
    expect(t.submissions()[0]).toMatchObject({ quest_type: 'unmatched', fuzzy_match: false, message_text: 'look at my setup' });
    expect(t.replies()).toEqual(['No match. Saved.']);
  });

  it('logs a photo with no caption as unmatched and asks for the quest name next time', async () => {
    const t = setup();
    await t.service.handle(photo(undefined));
    await t.service.handle(photo('   '));
    expect(t.submissions().map((s) => [s.quest_type, s.message_text])).toEqual([
      ['unmatched', ''],
      ['unmatched', ''], // a blank caption is saved as no caption
    ]);
    expect(t.replies()).toEqual(['Saved. Add a caption.', 'Saved. Add a caption.']);
  });

  it('does not know about binds, so there is no reminder', async () => {
    const t = setup();
    await t.service.handle(photo('share post'));
    expect(t.submissions()[0]).toMatchObject({ bound: false, uid: '', quest_type: 'share_post' });
    expect(t.replies()).toEqual(['Done: Share Post. Cheers!']);
    expect(t.copies[0]!.caption).not.toContain('UID');
  });

  it('a quest name without a screenshot is not logged: the member is reminded', async () => {
    const t = setup();
    await t.service.handle(text('share post'));
    expect(t.recorded).toHaveLength(0);
    expect(t.copies).toHaveLength(0);
    expect(t.replies()).toEqual(['Attach a screenshot.']);
  });

  it('a typo of a quest name without a screenshot gets the same reminder', async () => {
    const t = setup();
    await t.service.handle(text('share pst'));
    expect(t.replies()).toEqual(['Attach a screenshot.']);
  });

  it('uses strict keywords as whole words: "joint" is not the Event Join quest', async () => {
    const t = setup();
    await t.service.handle(photo('join'));
    await t.service.handle(photo('joint'));
    expect(t.submissions().map((s) => s.quest_type)).toEqual(['event_join', 'unmatched']);
  });

  it('is logged once if Telegram delivers the same message twice', async () => {
    const t = setup();
    const m = photo('share post');
    await t.service.handle(m);
    await t.service.handle(m);
    expect(t.submissions()).toHaveLength(1);
    expect(t.copies).toHaveLength(1);
    expect(t.replies()).toHaveLength(1);
  });

  it('records the time the member sent it, not the time it was processed', async () => {
    const t = setup();
    await t.service.handle(photo('share post', { date: new Date('2026-11-03T23:59:58Z') }));
    expect(t.submissions()[0]).toMatchObject({ timestamp_utc: '2026-11-03T23:59:58Z', date_utc: '2026-11-03' });
  });
});

describe('albums', () => {
  it('logs one row for an album of three photos, using the caption from whichever photo has it', async () => {
    vi.useFakeTimers();
    const t = setup();
    const group = 'album-1';
    const a = photo(undefined, { messageId: 2001, mediaGroupId: group });
    const b = photo('boost post', { messageId: 2002, mediaGroupId: group });
    const c = photo(undefined, { messageId: 2003, mediaGroupId: group });
    // Telegram does not promise the order.
    await t.service.handle(c);
    await t.service.handle(a);
    await t.service.handle(b);
    expect(t.recorded).toHaveLength(0); // still waiting for the last photo

    await vi.advanceTimersByTimeAsync(1100);
    expect(t.submissions()).toHaveLength(1);
    expect(t.submissions()[0]).toMatchObject({ quest_type: 'boost_post', message_text: 'boost post', attachment_url: 'FILE-2001' });
    expect(t.recorded[0]!.id).toBe(`tg:sub:${USER}:2001`);
    expect(t.copies).toHaveLength(1);
    expect(t.copies[0]).toMatchObject({ messageId: 2001 });
    expect(t.more).toEqual([{ fromChatId: USER, messageIds: [2002, 2003] }]);
    expect(t.replies()).toEqual(['Done: Boost Post. Cheers!']);
  });

  it('keeps the album in the submission even if copying the rest fails', async () => {
    vi.useFakeTimers();
    const t = setup({ copyMore: () => Promise.reject(new Error('flood')) });
    await t.service.handle(photo('share post', { messageId: 2101, mediaGroupId: 'g' }));
    await t.service.handle(photo(undefined, { messageId: 2102, mediaGroupId: 'g' }));
    await vi.advanceTimersByTimeAsync(1100);
    expect(t.submissions()).toHaveLength(1);
    expect(t.lines.some((l) => l.level === 'warn' && /rest of an album/.test(l.message))).toBe(true);
  });

  it('does not log a second row for a photo that arrives after its album was already logged', async () => {
    vi.useFakeTimers();
    const t = setup();
    await t.service.handle(photo('share post', { messageId: 2151, mediaGroupId: 'slow' }));
    await t.service.handle(photo(undefined, { messageId: 2152, mediaGroupId: 'slow' }));
    await vi.advanceTimersByTimeAsync(1100);
    expect(t.submissions()).toHaveLength(1);
    expect(t.replies()).toEqual(['Done: Share Post. Cheers!']);

    await t.service.handle(photo(undefined, { messageId: 2153, mediaGroupId: 'slow' })); // slow to arrive
    await vi.advanceTimersByTimeAsync(5000);
    expect(t.submissions()).toHaveLength(1); // still one row
    expect(t.replies()).toHaveLength(1); // and no confusing second reply
    expect(t.more).toEqual([{ fromChatId: USER, messageIds: [2152] }, { fromChatId: USER, messageIds: [2153] }]); // but the image still reaches the reviewers
  });

  it('treats albums from two members, or two albums, as separate submissions', async () => {
    vi.useFakeTimers();
    const t = setup();
    await t.service.handle(photo('share post', { messageId: 2201, mediaGroupId: 'same-id' }));
    await t.service.handle(photo('boost post', { messageId: 2202, mediaGroupId: 'same-id', chatId: 6000, fromId: 6000 }));
    await t.service.handle(photo('share post', { messageId: 2203, mediaGroupId: 'other' }));
    await vi.advanceTimersByTimeAsync(1100);
    expect(t.submissions()).toHaveLength(3);
  });

  it('finishes an album still waiting when the bot shuts down', async () => {
    vi.useFakeTimers();
    const t = setup();
    await t.service.handle(photo('share post', { messageId: 2301, mediaGroupId: 'g' }));
    await t.service.handle(photo(undefined, { messageId: 2302, mediaGroupId: 'g' }));
    await t.service.stop();
    expect(t.submissions()).toHaveLength(1);
  });
});

describe('link submissions', () => {
  it('logs a message with a link and no image as the configured link quest, and copies it for review', async () => {
    const t = setup();
    const m = text('my write-up https://example.com/post/1 enjoy');
    await t.service.handle(m);
    expect(t.submissions()[0]).toMatchObject({
      quest_type: 'ugc',
      link_url: 'https://example.com/post/1',
      attachment_url: '',
      message_text: 'my write-up https://example.com/post/1 enjoy',
      channel_name: TELEGRAM_CHANNEL_NAME,
      message_link: 'https://t.me/c/1234567890/701',
      platform: 'telegram',
      uid: '',
    });
    expect(t.copies[0]).toMatchObject({ messageId: m.messageId });
    expect(t.replies()).toEqual(['Logged your link.']);
  });

  it('finds a link hidden behind words, which is not in the text at all', async () => {
    const t = setup();
    const hidden: TgEntity = { type: 'text_link', offset: 3, length: 8, url: 'https://example.com/hidden' };
    await t.service.handle(text('my video', { entities: [hidden] }));
    expect(t.submissions()[0]).toMatchObject({ quest_type: 'ugc', link_url: 'https://example.com/hidden' });
  });

  it('prefers a link over a quest name when a message has both and no image', async () => {
    const t = setup();
    await t.service.handle(text('share post https://example.com/p'));
    expect(t.submissions()[0]).toMatchObject({ quest_type: 'ugc' });
  });

  it('logs a link without any bind reminder', async () => {
    const t = setup();
    await t.service.handle(text('https://example.com/p'));
    expect(t.submissions()[0]).toMatchObject({ bound: false });
    expect(t.replies()).toEqual(['Logged your link.']);
  });

  it('ignores addresses without a scheme, as the Discord side does', async () => {
    const t = setup();
    await t.service.handle(text('see example.com/page'));
    expect(t.recorded).toHaveLength(0);
    expect(t.replies()[0]).toContain('Quest names');
  });
});

describe('after the campaign ends', () => {
  const END = new Date('2026-11-22T23:59:59Z');

  it('answers submissions with the ended message and logs nothing: image, link, and quest name alike', async () => {
    const t = setup({ end: END });
    const late = new Date('2026-11-23T00:00:00Z');
    await t.service.handle(photo('share post', { date: late }));
    await t.service.handle(text('https://example.com/p', { date: late }));
    await t.service.handle(text('share post', { date: late }));
    expect(t.replies()).toEqual(['Season over.', 'Season over.', 'Season over.']);
    expect(t.recorded).toHaveLength(0);
    expect(t.copies).toHaveLength(0);
  });

  it('still logs a message sent in time that is only processed later (for example after downtime)', async () => {
    const t = setup({ end: END });
    await t.service.handle(photo('share post', { date: new Date('2026-11-22T23:59:59Z') }));
    expect(t.submissions()).toHaveLength(1);
  });

  it('does not invite anyone to submit: /start, /help and plain chat say the campaign ended', async () => {
    const t = setup({ end: END });
    const late = new Date('2026-12-01T00:00:00Z');
    await t.service.handle(command('start', '', { date: late }));
    await t.service.handle(command('help', '', { date: late }));
    await t.service.handle(text('hello', { date: late }));
    expect(t.replies()).toEqual(['Season over.', 'Season over.', 'Season over.']);
  });

  it('still shows the welcome and help text on the last day', async () => {
    const t = setup({ end: END });
    await t.service.handle(command('start', '', { date: new Date('2026-11-22T23:59:59Z') }));
    expect(t.replies()).toEqual(['Welcome!']);
  });

  it('ignores a photo that arrives late for an album that was already answered as ended', async () => {
    vi.useFakeTimers();
    const t = setup({ end: END });
    const late = new Date('2026-11-23T00:00:00Z');
    await t.service.handle(photo('share post', { messageId: 2451, mediaGroupId: 'g', date: late }));
    await vi.advanceTimersByTimeAsync(1100);
    await t.service.handle(photo(undefined, { messageId: 2452, mediaGroupId: 'g', date: late }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(t.replies()).toEqual(['Season over.']);
    expect(t.more).toHaveLength(0);
  });

  it('answers a late album once', async () => {
    vi.useFakeTimers();
    const t = setup({ end: END });
    const late = new Date('2026-11-23T00:00:00Z');
    await t.service.handle(photo('share post', { messageId: 2401, mediaGroupId: 'g', date: late }));
    await t.service.handle(photo(undefined, { messageId: 2402, mediaGroupId: 'g', date: late }));
    await vi.advanceTimersByTimeAsync(1100);
    expect(t.replies()).toEqual(['Season over.']);
    expect(t.recorded).toHaveLength(0);
  });
});

describe('when something goes wrong', () => {
  it('still logs the submission, with a placeholder link, if the review copy fails', async () => {
    const t = setup({ copy: () => Promise.reject(new Error('chat not found')) });
    const m = photo('share post');
    await t.service.handle(m);
    expect(t.submissions()[0]).toMatchObject({
      quest_type: 'share_post',
      message_link: `tg-dm:${USER}/${m.messageId}`,
      attachment_url: `FILE-${m.messageId}`,
    });
    expect(t.lines.some((l) => l.level === 'error' && /review channel/.test(l.message))).toBe(true);
    expect(t.replies()[0]).toMatch(/^Done:/);
  });

  it('uses the placeholder too when Telegram answers with a scheduled message (id 0)', async () => {
    const t = setup({ copy: () => Promise.resolve(0) });
    const m = photo('share post');
    await t.service.handle(m);
    expect(t.submissions()[0]!.message_link).toBe(`tg-dm:${USER}/${m.messageId}`);
  });

  it('never says "Logged" when the row could not be made durable, and logs the row for manual recovery', async () => {
    const t = setup({
      record: () => {
        throw new Error('disk full');
      },
    });
    await t.service.handle(photo('share post'));
    expect(t.replies()).toEqual(['Something broke.']);
    const failure = t.lines.find((l) => l.message.startsWith('SUBMISSION NOT SAVED'));
    expect(failure?.level).toBe('error');
    expect(JSON.stringify(failure?.fields)).toContain('share_post');
  });

  it('keeps the row when the reply cannot be sent (for example the member blocked the bot)', async () => {
    const t = setup({ send: () => Promise.reject(new Error('Forbidden: bot was blocked by the user')) });
    await expect(t.service.handle(photo('share post'))).resolves.toBeUndefined();
    expect(t.submissions()).toHaveLength(1);
    expect(t.lines.some((l) => l.level === 'warn' && /could not send a reply/.test(l.message))).toBe(true);
  });

  it('survives an unexpected error in the handler, and tells the member', async () => {
    const broken = new QuestMatcher(config.quests, config.fuzzyThreshold);
    vi.spyOn(broken, 'match').mockImplementation(() => {
      throw new Error('boom');
    });
    const t = setup({ matcher: broken });
    await expect(t.service.handle(photo('share post'))).resolves.toBeUndefined();
    expect(t.replies()).toEqual(['Something broke.']);
    expect(t.lines.some((l) => l.level === 'error' && l.message === 'Telegram handler failed')).toBe(true);
  });
});

describe('review channel helpers', () => {
  it('builds the t.me/c link from a private channel ID', () => {
    expect(reviewLink('-1001234567890', 42)).toBe('https://t.me/c/1234567890/42');
  });

  it('keeps the review caption within Telegram\'s 1024 characters, whatever the member wrote', () => {
    const caption = reviewCaption({ userId: '1', username: '@m', questType: 'share_post', fuzzy: false, text: 'x'.repeat(5000) });
    expect(caption.length).toBeLessThanOrEqual(1024);
    expect(caption.startsWith('User 1 @m | share_post')).toBe(true);
    expect(caption.endsWith('…')).toBe(true);
  });

  it('leaves out the text section when there is no caption', () => {
    expect(reviewCaption({ userId: '1', username: '@m', questType: 'unmatched', fuzzy: false, text: '  ' })).toBe(
      'User 1 @m | unmatched',
    );
  });
});
