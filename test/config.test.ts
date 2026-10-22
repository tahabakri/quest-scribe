import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, parseConfig } from '../src/config.js';

const MINIMAL = `
quests:
  - keyword: daily check-in
    type: daily_check_in
`;

const parse = (text: string, env: NodeJS.ProcessEnv = {}) => parseConfig({ text, origin: 'test.yml' }, env);

function configError(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return (err as Error).message;
  }
  throw new Error('expected a ConfigError');
}

describe('config', () => {
  it('parses the committed example config', () => {
    const text = readFileSync(new URL('../config.example.yml', import.meta.url), 'utf8');
    const config = parse(text);

    expect(config.quests.map((q) => q.type)).toEqual(['daily_check_in', 'share_post', 'event_attendance', 'invite']);
    expect(config.fuzzyThreshold).toBe(0.8);
    expect(config.sheets).toEqual({
      submissionsTab: 'Submissions',
      flushIntervalSeconds: 5,
      flushMaxRows: 20,
    });
  });

  it('applies defaults for every optional setting', () => {
    const config = parse(MINIMAL);
    expect(config.fuzzyThreshold).toBe(0.8);
    expect(config.replies.ended).toMatch(/ended/);
    expect(config.imageExtensions).toEqual(['png', 'jpg', 'jpeg', 'gif', 'webp']);
    expect(config.sheets.flushMaxRows).toBe(20);
  });

  it('reads the per-quest strict flag, off by default', () => {
    expect(parse(MINIMAL).quests[0]?.strict).toBe(false);
    const strict = parse(MINIMAL.replace('    type: daily_check_in', '    type: daily_check_in\n    strict: true'));
    expect(strict.quests[0]?.strict).toBe(true);
  });

  it('reads the per-quest review flag, off by default', () => {
    expect(parse(MINIMAL).quests[0]?.review).toBe(false);
    const flagged = parse(MINIMAL.replace('    type: daily_check_in', '    type: daily_check_in\n    review: true'));
    expect(flagged.quests[0]?.review).toBe(true);
  });

  it('interpolates ${VAR} and reports every missing variable at once', () => {
    const text = `${MINIMAL}telegram:\n  replies:\n    logged: "\${FIRST}"\n    error: "\${SECOND}"\n`;
    expect(parse(text, { FIRST: 'Done!', SECOND: 'Oops' }).telegram.replies.logged).toBe('Done!');
    const message = configError(() => parse(text, { FIRST: '  ' }));
    expect(message).toContain('FIRST');
    expect(message).toContain('SECOND');
  });

  it('prefers CONFIG_YAML over the config file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qs-config-'));
    const path = join(dir, 'config.yml');
    writeFileSync(path, MINIMAL.replace('daily check-in', 'from file'));
    const env = { CONFIG_PATH: path, CONFIG_YAML: MINIMAL.replace('daily check-in', 'from env') };
    expect(loadConfig(env).quests[0]?.keyword).toBe('from env');
    expect(loadConfig({ CONFIG_PATH: path }).quests[0]?.keyword).toBe('from file');
  });

  it('fails fast with a hint when no config exists', () => {
    const message = configError(() => loadConfig({ CONFIG_PATH: join(tmpdir(), 'does-not-exist.yml') }));
    expect(message).toMatch(/config\.example\.yml/);
  });

  it.each([
    ['an unknown key (typo)', MINIMAL + '\nfuzzy_treshold: 0.7\n', /fuzzy_treshold/],
    ['a threshold above 1', MINIMAL + '\nfuzzy_threshold: 1.5\n', /fuzzy_threshold: must be at most 1/],
    ['a threshold of 0', MINIMAL + '\nfuzzy_threshold: 0\n', /fuzzy_threshold: must be greater than 0/],
    [
      'a duplicate keyword (ignoring case and punctuation)',
      MINIMAL.replace('    type: daily_check_in', '    type: daily_check_in\n  - keyword: "DAILY  check_in!"\n    type: other'),
      /quests\[1\]\.keyword: duplicates quests\[0\]/,
    ],
    [
      'a keyword with no letters or digits',
      MINIMAL.replace('    type: daily_check_in', '    type: daily_check_in\n  - keyword: "✅"\n    type: other'),
      /quests\[1\]\.keyword: must contain at least one letter or digit/,
    ],
    ['the reserved "unmatched" type', MINIMAL.replace('type: daily_check_in', 'type: unmatched'), /reserved/],
    [
      'a strict flag that is not true or false',
      MINIMAL.replace('    type: daily_check_in', '    type: daily_check_in\n    strict: maybe'),
      /quests\[0\]\.strict/,
    ],
    [
      'a review flag that is not true or false',
      MINIMAL.replace('    type: daily_check_in', '    type: daily_check_in\n    review: sometimes'),
      /quests\[0\]\.review/,
    ],
    ['invalid YAML', 'quests: [unclosed', /invalid YAML/],
  ])('rejects %s', (_label, text, expected) => {
    expect(configError(() => parse(text))).toMatch(expected);
  });
});

// The Discord bot of the same campaign can read the same file, so the quest list is written once.
describe('a config file shared with the Discord bot', () => {
  const SHARED = `
quests:
  - keyword: daily check-in
    type: daily_check_in
    name: Daily Check-In
    reply: Nice, checked in!
bind:
  command: bind
  command_description: Link your account
  id_label: uid
  id_description: Your account ID
  id_pattern: '^\\d{6,12}$'
  role_id: "\${MEMBER_ROLE_ID}"
  replies:
    success: Linked.
    invalid: Invalid ID.
channels:
  - id: "\${SUBMISSIONS_CHANNEL_ID}"
    mode: image
  - id: 1234567890123456789
    mode: link
    quest_type: content_link
replies:
  unmatched: No match.
  no_image: Attach a screenshot.
  unbound: Run /bind first.
  ended: Season over.
reactions:
  success: "✅"
warning_delete_after_seconds: 30
telegram:
  welcome: Hi there
`;

  it('ignores everything that only the Discord bot uses, and keeps the shared and Telegram settings', () => {
    const config = parse(SHARED);
    expect(config.quests[0]).toMatchObject({ keyword: 'daily check-in', type: 'daily_check_in', name: 'Daily Check-In' });
    expect(config.replies.ended).toBe('Season over.');
    expect(config.telegram.welcome).toBe('Hi there');
  });

  it('does not need the variables that only the Discord part refers to', () => {
    // MEMBER_ROLE_ID and SUBMISSIONS_CHANNEL_ID are not set here, and that is fine.
    expect(() => parse(SHARED, {})).not.toThrow();
  });

  it('still reports a missing variable in a part this bot uses', () => {
    expect(configError(() => parse(SHARED.replace('Hi there', '${WELCOME_TEXT}')))).toContain('WELCOME_TEXT');
  });

  it('still rejects a typo in the settings it does use', () => {
    expect(() => parse(SHARED.replace('welcome: Hi there', 'welcom: Hi there'))).toThrow(/telegram/);
  });
});
