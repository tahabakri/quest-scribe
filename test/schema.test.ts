import { describe, expect, it } from 'vitest';
import {
  SUBMISSION_HEADERS,
  SUBMISSION_UPGRADE_FROM,
  normalizeLegacyRow,
  parsePlatform,
} from '../src/sheets/schema.js';

describe('sheet headers', () => {
  it('end with the platform column, so the existing 13 columns keep their positions', () => {
    expect(SUBMISSION_HEADERS).toHaveLength(14);
    expect(SUBMISSION_HEADERS.at(-1)).toBe('platform');
    expect(SUBMISSION_HEADERS.slice(0, 3)).toEqual(['timestamp_utc', 'user_id', 'username']);
    expect(SUBMISSION_HEADERS.indexOf('message_link')).toBe(11);
  });

  it('know the two layouts an existing Submissions tab may have', () => {
    expect(SUBMISSION_UPGRADE_FROM[0]).toEqual([
      'timestamp_utc', 'discord_user_id', 'discord_username', 'uid', 'bound', 'quest_type', 'fuzzy_match',
      'channel_name', 'message_text', 'attachment_url', 'link_url', 'message_link', 'date_utc',
    ]);
    expect(SUBMISSION_UPGRADE_FROM[1]).toEqual(SUBMISSION_HEADERS.slice(0, 13));
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
