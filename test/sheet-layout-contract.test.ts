import { describe, expect, it } from 'vitest';
import { BIND_HEADERS, SUBMISSION_HEADERS, parsePlatform } from '../src/sheets/schema.js';

// The Discord bot (quest-ledger) and the Telegram bot (quest-scribe) can write the SAME Google
// Sheet, and each insists that row 1 matches its layout exactly. If this file has to change,
// change the same test in the sibling repository in the same release, and deploy the Discord
// bot first: a bot still on the old layout stops writing as soon as the headers change.
describe('sheet layout shared with the sibling bot', () => {
  it('Submissions columns', () => {
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

  it('Binds columns', () => {
    expect([...BIND_HEADERS]).toEqual([
      'timestamp_utc',
      'user_id',
      'username',
      'uid',
      'duplicate_uid',
      'last_updated_utc',
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
