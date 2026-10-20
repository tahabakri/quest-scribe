import { describe, expect, it } from 'vitest';
import {
  BIND_HEADERS,
  BIND_UPGRADE_FROM,
  SUBMISSION_HEADERS,
  SUBMISSION_UPGRADE_FROM,
  bindKey,
  normalizeLegacyRow,
  parseBindRow,
  parsePlatform,
} from '../src/sheets/schema.js';

describe('sheet headers', () => {
  it('end with the platform column, so the existing 13 and 6 columns keep their positions', () => {
    expect(SUBMISSION_HEADERS).toHaveLength(14);
    expect(SUBMISSION_HEADERS.at(-1)).toBe('platform');
    expect(BIND_HEADERS).toHaveLength(7);
    expect(BIND_HEADERS.at(-1)).toBe('platform');
    expect(SUBMISSION_HEADERS.slice(0, 3)).toEqual(['timestamp_utc', 'user_id', 'username']);
    expect(SUBMISSION_HEADERS.indexOf('message_link')).toBe(11);
  });

  it('know the two layouts an existing sheet may have', () => {
    expect(SUBMISSION_UPGRADE_FROM[0]).toEqual([
      'timestamp_utc', 'discord_user_id', 'discord_username', 'uid', 'bound', 'quest_type', 'fuzzy_match',
      'channel_name', 'message_text', 'attachment_url', 'link_url', 'message_link', 'date_utc',
    ]);
    expect(BIND_UPGRADE_FROM[0]).toEqual(['timestamp_utc', 'discord_user_id', 'discord_username', 'uid', 'duplicate_uid', 'last_updated_utc']);
    expect(SUBMISSION_UPGRADE_FROM[1]).toEqual(SUBMISSION_HEADERS.slice(0, 13));
    expect(BIND_UPGRADE_FROM[1]).toEqual(BIND_HEADERS.slice(0, 6));
  });
});

describe('parsePlatform', () => {
  it.each([
    ['', 'discord'],
    [undefined, 'discord'],
    ['  ', 'discord'],
    ['discord', 'discord'],
    ['Discord', 'discord'],
    ['telegram', 'telegram'],
    [' TELEGRAM ', 'telegram'],
    ['whatsapp', undefined],
  ])('%j -> %s', (value, expected) => {
    expect(parsePlatform(value)).toBe(expected);
  });
});

describe('bindKey', () => {
  it('never lets equal IDs on two platforms collide', () => {
    expect(bindKey('discord', '42')).not.toBe(bindKey('telegram', '42'));
  });
});

describe('parseBindRow', () => {
  const base = ['2026-01-01T00:00:00Z', '100000000000000001', 'member', '123456', 'FALSE', '2026-01-01T00:00:00Z'];

  it('reads a row from before the platform column as a Discord bind', () => {
    expect(parseBindRow(base)).toMatchObject({ user_id: '100000000000000001', uid: '123456', platform: 'discord', duplicate_uid: false });
  });

  it('reads Telegram rows, whose user IDs are much shorter than Discord ones', () => {
    expect(parseBindRow(['2026-01-01T00:00:00Z', '824126265', '@member', '123456', 'TRUE', '2026-01-02T00:00:00Z', 'telegram'])).toMatchObject({
      user_id: '824126265',
      username: '@member',
      duplicate_uid: true,
      platform: 'telegram',
    });
  });

  it.each([
    ['no user ID', ['t', '', 'n', '123456']],
    ['a user ID with letters', ['t', '12ab', 'n', '123456']],
    ['no UID', ['t', '123', 'n', '']],
    ['a platform we do not serve', ['t', '123', 'n', '123456', 'FALSE', 't', 'whatsapp']],
  ])('skips a row with %s', (_label, cells) => {
    expect(parseBindRow(cells)).toBeUndefined();
  });
});

describe('normalizeLegacyRow', () => {
  it('renames the Discord-prefixed keys and defaults the platform', () => {
    const row = normalizeLegacyRow({ discord_user_id: '1', discord_username: 'a', uid: '2' });
    expect(row).toEqual({ user_id: '1', username: 'a', uid: '2', platform: 'discord' });
  });

  it('keeps an existing platform and current keys untouched', () => {
    const current = { user_id: '1', username: 'a', platform: 'telegram' };
    expect(normalizeLegacyRow(current)).toEqual(current);
  });
});
