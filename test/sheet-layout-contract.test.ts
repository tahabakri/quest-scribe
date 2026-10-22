import { describe, expect, it } from 'vitest';
import { SUBMISSION_HEADERS, parsePlatform } from '../src/sheets/schema.js';

// The Discord bot (quest-ledger) and this Telegram bot (quest-scribe) write the SAME Submissions
// tab, and each insists that row 1 matches its layout exactly. If this file has to change,
// change the same test in the sibling repository in the same release, and deploy the Discord
// bot first: a bot still on the old layout stops writing as soon as the headers change.
//
// The Binds tab belongs to the Discord bot alone. This bot never reads or writes it.
describe('Submissions layout shared with the Discord bot', () => {
  it('columns', () => {
    expect([...SUBMISSION_HEADERS]).toEqual([
      'timestamp_utc',
      'user_id',
      'username',
      'uid',
      'bound',
      'quest_type',
      'fuzzy_match',
      'channel_name',
      'message_text',
      'attachment_url',
      'link_url',
      'message_link',
      'date_utc',
      'platform',
    ]);
  });

  it('platform values, and a blank cell meaning Discord (rows from before the column existed)', () => {
    expect(parsePlatform('discord')).toBe('discord');
    expect(parsePlatform('telegram')).toBe('telegram');
    expect(parsePlatform('')).toBe('discord');
    expect(parsePlatform('slack')).toBeUndefined();
  });
});
