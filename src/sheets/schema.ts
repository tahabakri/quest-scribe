/** The chat platforms the bot takes submissions from. Written to the `platform` column. */
export type Platform = 'discord' | 'telegram';

/**
 * Sheet layout. Row 1 of each tab holds exactly these headers, and rows are
 * written in this column order. Row objects use the header names as keys, so the
 * write-ahead log (data/fallback.jsonl) reads like the sheet itself.
 */
export const SUBMISSION_HEADERS = [
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
] as const;

export const BIND_HEADERS = [
  'timestamp_utc',
  'user_id',
  'username',
  'uid',
  'duplicate_uid',
  'last_updated_utc',
  'platform',
] as const;

// Before Telegram was added the two identity columns carried a Discord prefix and
// there was no platform column.
const LEGACY_NAMES: Record<string, string> = { user_id: 'discord_user_id', username: 'discord_username' };
const legacyOf = (headers: readonly string[]): string[] => headers.slice(0, -1).map((h) => LEGACY_NAMES[h] ?? h);

/**
 * Layouts an existing sheet may still have. When row 1 matches one of these exactly
 * (and the columns after it are empty) the bot rewrites row 1 to the current
 * headers itself, so nobody has to edit the sheet by hand and nothing is ever
 * written under the wrong column.
 */
export const SUBMISSION_UPGRADE_FROM: readonly (readonly string[])[] = [
  legacyOf(SUBMISSION_HEADERS), // Discord-only names, no platform column
  SUBMISSION_HEADERS.slice(0, -1), // identity columns already renamed, no platform column yet
];
export const BIND_UPGRADE_FROM: readonly (readonly string[])[] = [legacyOf(BIND_HEADERS), BIND_HEADERS.slice(0, -1)];

export interface SubmissionRow {
  timestamp_utc: string;
  user_id: string;
  username: string;
  uid: string;
  bound: boolean;
  quest_type: string;
  fuzzy_match: boolean;
  channel_name: string;
  message_text: string;
  attachment_url: string;
  link_url: string;
  message_link: string;
  date_utc: string;
  platform: Platform;
}

export interface BindRow {
  /** When this user first bound. Preserved when they re-bind. */
  timestamp_utc: string;
  user_id: string;
  username: string;
  uid: string;
  duplicate_uid: boolean;
  last_updated_utc: string;
  platform: Platform;
}

/** Cells are written RAW: strings stay text (no formula injection), booleans become TRUE/FALSE. */
export type Cell = string | boolean;

/** Column index (0-based) that uniquely identifies a submission, used to skip rows already written. */
export const MESSAGE_LINK_COLUMN = SUBMISSION_HEADERS.indexOf('message_link');

export function submissionCells(row: SubmissionRow): Cell[] {
  return SUBMISSION_HEADERS.map((header) => row[header]);
}

export function bindCells(row: BindRow): Cell[] {
  return BIND_HEADERS.map((header) => row[header]);
}

/** The same user ID can exist on two platforms, so identity is always platform plus ID. */
export function bindKey(platform: Platform, userId: string): string {
  return `${platform}:${userId}`;
}

/** Blank means Discord: rows written before the platform column existed are all Discord. */
export function parsePlatform(value: string | undefined): Platform | undefined {
  const normalized = (value ?? '').trim().toLowerCase();
  if (normalized === '' || normalized === 'discord') return 'discord';
  if (normalized === 'telegram') return 'telegram';
  return undefined;
}

/**
 * Brings a row read from an older write-ahead log up to the current shape: the
 * Discord-prefixed identity keys become user_id / username, and a missing platform
 * means Discord.
 */
export function normalizeLegacyRow<T extends object>(row: T): T {
  const record: Record<string, unknown> = { ...(row as Record<string, unknown>) };
  for (const [current, legacy] of Object.entries(LEGACY_NAMES)) {
    if (legacy in record && !(current in record)) record[current] = record[legacy];
    delete record[legacy];
  }
  record.platform ??= 'discord';
  return record as T;
}

/** Parses a Binds data row read back from the sheet. Returns undefined for blank or malformed rows. */
export function parseBindRow(cells: readonly string[]): BindRow | undefined {
  const [timestamp = '', userId = '', username = '', uid = '', duplicate = '', lastUpdated = '', platformCell] = cells.map(
    (c) => c.trim(),
  );
  const platform = parsePlatform(platformCell);
  if (!/^\d{1,20}$/.test(userId) || uid === '' || platform === undefined) return undefined;
  return {
    timestamp_utc: timestamp,
    user_id: userId,
    username,
    uid,
    duplicate_uid: duplicate.toUpperCase() === 'TRUE',
    last_updated_utc: lastUpdated,
    platform,
  };
}

/** ISO 8601 UTC to the second, e.g. 2026-10-06T14:22:31Z. */
export function isoSeconds(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

const ISO_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/**
 * True when a bind stamped `candidate` predates one stamped `current`, so it must
 * not replace it (e.g. an old bind replayed from the log). Timestamps in this
 * fixed format compare correctly as strings; anything else never counts as older.
 */
export function isOlderBind(candidate: string, current: string): boolean {
  return ISO_SECONDS.test(candidate) && ISO_SECONDS.test(current) && candidate < current;
}
