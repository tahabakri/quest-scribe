import { describe, expect, it } from 'vitest';
import { hasEnded } from '../src/campaign.js';
import { ConfigError, parseConfig } from '../src/config.js';
import { readCampaignEnd, readTelegramEnv } from '../src/env.js';
import { redactSecrets } from '../src/logger.js';
import { buildHelpText, humanizeType, listedKeywords, questNameFor } from '../src/quests.js';

describe('quest names and the help list', () => {
  const quests = [
    { keyword: 'share post', type: 'share_post', name: 'Share Post' },
    { keyword: 'sharing post', type: 'share_post', review: true },
    { keyword: 'boost', type: 'boost_post' },
    { keyword: 'join', type: 'event_join', review: true },
    { keyword: 'join event', type: 'event_join', review: true },
  ];

  it.each([
    ['daily_check_in', 'Daily Check In'],
    ['ugc', 'Ugc'],
    ['daily-check_in', 'Daily Check In'],
    ['one', 'One'],
    ['', ''],
  ])('humanizeType(%j) = %j', (type, expected) => {
    expect(humanizeType(type)).toBe(expected);
  });

  it('uses the configured name, from any keyword of the type, else a readable form of the type', () => {
    expect(questNameFor(quests, 'share_post')).toBe('Share Post');
    expect(questNameFor(quests, 'boost_post')).toBe('Boost Post');
    expect(questNameFor(quests, 'unknown_type')).toBe('Unknown Type');
  });

  it('lists one caption per quest: the first that is not a close variant, else the first', () => {
    expect(listedKeywords(quests)).toEqual(['share post', 'boost', 'join']);
  });

  it('builds the help message: welcome text, a blank line, a heading, then the names', () => {
    expect(buildHelpText('Hello', 'Quests:', quests)).toBe('Hello\n\nQuests:\n- share post\n- boost\n- join');
  });
});

describe('hasEnded', () => {
  const end = new Date('2026-11-22T23:59:59Z');
  it('is a strict "after": the last second still counts', () => {
    expect(hasEnded(end, new Date('2026-11-22T23:59:59Z'))).toBe(false);
    expect(hasEnded(end, new Date('2026-11-22T23:59:59.001Z'))).toBe(true);
    expect(hasEnded(end, new Date('2026-11-23T00:00:00Z'))).toBe(true);
    expect(hasEnded(end, new Date('2026-10-05T00:00:00Z'))).toBe(false);
  });

  it('never ends without an end date', () => {
    expect(hasEnded(undefined, new Date('2099-01-01T00:00:00Z'))).toBe(false);
  });
});

describe('readTelegramEnv', () => {
  // Fake token, assembled at runtime so secret scanners do not flag the fixture.
  const TOKEN = ['123456789', 'AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0'].join(':');

  it('needs a token', () => {
    expect(() => readTelegramEnv({})).toThrow(/TELEGRAM_BOT_TOKEN is not set/);
    expect(() => readTelegramEnv({ TELEGRAM_BOT_TOKEN: '   ' })).toThrow(/TELEGRAM_BOT_TOKEN is not set/);
  });

  it('reads the token and the review channel', () => {
    expect(readTelegramEnv({ TELEGRAM_BOT_TOKEN: ` ${TOKEN} `, TG_REVIEW_CHANNEL_ID: '-1001234567890' })).toEqual({
      token: TOKEN,
      reviewChannelId: '-1001234567890',
      groupIds: [],
    });
  });

  it('reads an optional API root for a self-hosted Bot API server, and rejects a malformed one', () => {
    const env = { TELEGRAM_BOT_TOKEN: TOKEN, TG_REVIEW_CHANNEL_ID: '-1001234567890' };
    expect(readTelegramEnv({ ...env, TELEGRAM_API_ROOT: ' http://localhost:8081 ' })?.apiRoot).toBe('http://localhost:8081');
    expect(readTelegramEnv({ ...env, TELEGRAM_API_ROOT: '' })).toEqual({ token: TOKEN, reviewChannelId: '-1001234567890', groupIds: [] });
    expect(() => readTelegramEnv({ ...env, TELEGRAM_API_ROOT: 'localhost:8081' })).toThrow(/TELEGRAM_API_ROOT must be a URL/);
  });

  it('reads the community group IDs, one or several, and rejects anything that is not a group ID', () => {
    const env = { TELEGRAM_BOT_TOKEN: TOKEN, TG_REVIEW_CHANNEL_ID: '-1001234567890' };
    expect(readTelegramEnv({ ...env, TG_GROUP_IDS: ' -1001111111111 , -1002222222222 ' }).groupIds).toEqual([-1001111111111, -1002222222222]);
    expect(readTelegramEnv({ ...env, TG_GROUP_IDS: '' }).groupIds).toEqual([]);
    for (const bad of ['@mygroup', '12345', '-123456', '-1001111111111,abc']) {
      expect(() => readTelegramEnv({ ...env, TG_GROUP_IDS: bad })).toThrow(/TG_GROUP_IDS must list group IDs/);
    }
  });

  it('rejects a token that is not one, without echoing it', () => {
    let message = '';
    try {
      readTelegramEnv({ TELEGRAM_BOT_TOKEN: 'not-a-token-SECRET', TG_REVIEW_CHANNEL_ID: '-1001234567890' });
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      message = (err as Error).message;
    }
    expect(message).toMatch(/not a bot token/);
    expect(message).not.toContain('SECRET');
  });

  it('works with a group and no review channel, but needs one of the two', () => {
    expect(readTelegramEnv({ TELEGRAM_BOT_TOKEN: TOKEN, TG_GROUP_IDS: '-1001111111111', TG_REVIEW_CHANNEL_ID: '  ' })).toEqual({
      token: TOKEN,
      groupIds: [-1001111111111],
    });
    expect(() => readTelegramEnv({ TELEGRAM_BOT_TOKEN: TOKEN })).toThrow(/Set TG_GROUP_IDS/);
  });

  it('checks the review channel when one is given, and it must look like a channel ID', () => {
    for (const bad of ['1234567890', '@mychannel', '-123456', 'abc']) {
      expect(() => readTelegramEnv({ TELEGRAM_BOT_TOKEN: TOKEN, TG_REVIEW_CHANNEL_ID: bad })).toThrow(/must be a channel ID starting with -100/);
    }
  });
});

describe('readCampaignEnd', () => {
  it('is unset by default', () => {
    expect(readCampaignEnd({})).toBeUndefined();
  });

  it('reads a UTC date-time', () => {
    expect(readCampaignEnd({ CAMPAIGN_END_UTC: '2026-11-22T23:59:59Z' })?.toISOString()).toBe('2026-11-22T23:59:59.000Z');
    expect(readCampaignEnd({ CAMPAIGN_END_UTC: ' 2026-11-22T23:59:59.500Z ' })?.getUTCMilliseconds()).toBe(500);
  });

  it.each(['2026-11-22', '2026-11-22T23:59:59', '2026-11-22T23:59:59+04:00', 'next friday', '2026-13-45T00:00:00Z', '2026-11-31T23:59:59Z', '2026-02-30T00:00:00Z', '2026-11-22T24:00:00Z'])(
    'refuses %j: it must say UTC, so the server time zone can never move the deadline',
    (value) => {
      expect(() => readCampaignEnd({ CAMPAIGN_END_UTC: value })).toThrow(/CAMPAIGN_END_UTC must be a real UTC date-time/);
    },
  );
});

describe('redactSecrets', () => {
  it('hides a Telegram bot token wherever it appears, including inside an API URL', () => {
    const token = ['123456789', 'AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0'].join(':');
    expect(redactSecrets(`failed: https://api.telegram.org/bot${token}/getUpdates (502)`)).toBe(
      'failed: https://api.telegram.org/bot<telegram-token-redacted>/getUpdates (502)',
    );
    expect(redactSecrets(`token=${token}`)).toBe('token=<telegram-token-redacted>');
  });

  it('leaves ordinary log lines alone: IDs, times, file ids, links', () => {
    for (const line of [
      'submission logged chat=5000 user=5000 questType=share_post',
      '2026-11-01T10:00:00Z bind saved',
      'file AgACAgIAAxkBAAIBY2Yx_exampleFileId0123456789',
      'https://t.me/c/1234567890/701',
      'channel=-1001234567890 ratio 12:30',
    ]) {
      expect(redactSecrets(line)).toBe(line);
    }
  });
});

describe('config: Telegram and campaign options', () => {
  const MINIMAL = `
quests:
  - keyword: daily check-in
    type: daily_check_in
bind:
  command_description: Link your account
  id_label: uid
  id_description: Your account ID
  replies:
    success: Linked.
    invalid: Invalid ID.
replies:
  unmatched: No match.
  no_image: Attach a screenshot.
  unbound: Run /bind first.
`;
  const parse = (text: string) => parseConfig({ text, origin: 'test.yml' }, {});

  it('needs no telegram section: it has defaults', () => {
    const config = parse(MINIMAL);
    expect(config.telegram.replies.logged).toContain('{quest}');
    expect(config.telegram.linkQuestType).toBe('content_link');
    expect(config.telegram.welcome).toContain('campaign bot');
    expect(config.replies.ended).toMatch(/ended/);
  });

  it('reads the telegram section, the ended reply and quest names', () => {
    const config = parse(
      MINIMAL.replace('    type: daily_check_in', '    type: daily_check_in\n    name: Daily Check-In') +
        `
telegram:
  welcome: Hi there
  link_quest_type: shared_link
  replies:
    logged: "Done: {quest}"
    no_caption: Add a caption next time
`,
    ).telegram;
    expect(config.welcome).toBe('Hi there');
    expect(config.linkQuestType).toBe('shared_link');
    expect(config.replies.logged).toBe('Done: {quest}');
    expect(config.replies.noCaption).toBe('Add a caption next time');
    expect(config.replies.error).toMatch(/try again/); // untouched ones keep their defaults
  });

  it('knows nothing about binding: the default welcome sends members to the campaign bot, and old bind wording is ignored', () => {
    const config = parse(
      MINIMAL +
        `
sheets:
  binds_tab: Binds
  binds_refresh_minutes: 1
telegram:
  replies:
    bind_usage: Send /bind and your ID
    bind_invalid: Not an ID
    group_bind: Message me in private
    unbound: Run /bind first
`,
    );
    expect(config.telegram.welcome).toMatch(/campaign bot/);
    expect(config.telegram.welcome).not.toMatch(/\/bind/);
    expect(config.telegram.replies).not.toHaveProperty('unbound');
    expect(config.sheets).not.toHaveProperty('bindsTab');
  });

  it('reads quest names from the quests', () => {
    expect(parse(MINIMAL.replace('    type: daily_check_in', '    type: daily_check_in\n    name: Daily Check-In')).quests[0]?.name).toBe(
      'Daily Check-In',
    );
  });

  it('rejects two names for one quest type, and a help message Telegram cannot send', () => {
    const twoNames = MINIMAL.replace(
      '    type: daily_check_in',
      '    type: daily_check_in\n    name: One\n  - keyword: check in\n    type: daily_check_in\n    name: Two',
    );
    expect(() => parse(twoNames)).toThrow(/quests\[1\]\.name: quest type "daily_check_in" already has a different name/);
    expect(() => parse(MINIMAL + `telegram:\n  welcome: "${'w'.repeat(3000)}"\n  help_quests_heading: "${'h'.repeat(200)}"\n`.replace('welcome: "' + 'w'.repeat(3000), 'welcome: "' + 'w'.repeat(3000)))).not.toThrow();
    const manyQuests = Array.from({ length: 200 }, (_, i) => `  - keyword: quest number ${i} with a long name\n    type: q${i}`).join('\n');
    const tooLong = MINIMAL.replace('quests:\n  - keyword: daily check-in\n    type: daily_check_in', `quests:\n${manyQuests}`) + `telegram:\n  welcome: "${'w'.repeat(2900)}"\n`;
    expect(() => parse(tooLong)).toThrow(/the \/help message .* characters; Telegram allows 4096/);
  });

  it('rejects an unknown key in the telegram section (a typo must not be ignored)', () => {
    expect(() => parse(MINIMAL + 'telegram:\n  replies:\n    loged: oops\n')).toThrow(/telegram\.replies/);
  });
});
