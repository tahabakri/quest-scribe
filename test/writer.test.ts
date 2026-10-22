import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { silentLogger } from '../src/logger.js';
import { SUBMISSION_HEADERS, SUBMISSION_UPGRADE_FROM } from '../src/sheets/schema.js';
import { type WalEntry, WriteAheadLog } from '../src/wal.js';
import { SheetWriter, type WriterOptions } from '../src/writer.js';
import { FakeSheets, submission } from './fakes.js';

const TABS = { submissions: 'Submissions' };
const logs: WriteAheadLog[] = [];

function setup(overrides: Partial<WriterOptions> = {}) {
  const wal = new WriteAheadLog(join(mkdtempSync(join(tmpdir(), 'ql-writer-')), 'fallback.jsonl'));
  wal.open();
  logs.push(wal);
  const sheets = new FakeSheets();
  const sleeps: number[] = [];
  const writer = new SheetWriter({
    gateway: sheets,
    wal,
    tabs: TABS,
    flushIntervalMs: 5_000,
    flushMaxRows: 20,
    log: silentLogger,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    ...overrides,
  });
  return { wal, sheets, writer, sleeps };
}

/** A second writer over the same log, as after a restart. */
function restart(wal: WriteAheadLog, sheets: FakeSheets) {
  const reopened = new WriteAheadLog(wal.path);
  const state = reopened.open();
  logs.push(reopened);
  const writer = new SheetWriter({ gateway: sheets, wal: reopened, tabs: TABS, flushIntervalMs: 5_000, flushMaxRows: 20, log: silentLogger, sleep: () => Promise.resolve() });
  writer.restore(state);
  return { writer, wal: reopened };
}

function links(sheets: FakeSheets): string[] {
  return sheets.dataRows(TABS.submissions).map((row) => String(row[SUBMISSION_HEADERS.indexOf('message_link')]));
}

afterEach(() => {
  vi.useRealTimers();
  for (const wal of logs.splice(0)) wal.close();
});

describe('SheetWriter: batching', () => {
  it('writes the log before anything else, then batches rows into one append', async () => {
    const { wal, sheets, writer } = setup({ flushMaxRows: 3 });
    const rows = [submission(), submission(), submission()];
    writer.record(rows[0]!);
    writer.record(rows[1]!);
    expect(new WriteAheadLog(wal.path).read().pending).toHaveLength(2);
    expect(sheets.callsOf('appendRows')).toHaveLength(0);

    writer.record(rows[2]!); // reaches flushMaxRows
    await writer.flush();
    expect(sheets.callsOf('appendRows')).toEqual([{ op: 'appendRows', tab: 'Submissions', rows: 3 }]);
    expect(links(sheets)).toEqual(rows.map((r) => (r.kind === 'submission' ? r.row.message_link : '')));
    expect(new WriteAheadLog(wal.path).read().pending).toHaveLength(0);
  });

  it('flushes a partial batch on the interval', async () => {
    vi.useFakeTimers();
    const { sheets, writer } = setup();
    writer.start();
    writer.record(submission());
    await vi.advanceTimersByTimeAsync(4_999);
    expect(sheets.dataRows(TABS.submissions)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(sheets.dataRows(TABS.submissions)).toHaveLength(1);
  });

  it('keeps all rows through a burst: 30 rows, no drops, no duplicates', async () => {
    const { sheets, writer } = setup();
    const rows = Array.from({ length: 30 }, () => submission());
    for (const row of rows) writer.record(row);
    await writer.flush();
    expect(links(sheets)).toHaveLength(30);
    expect(new Set(links(sheets)).size).toBe(30);
    expect(sheets.callsOf('appendRows').length).toBeLessThanOrEqual(2);
  });

  it('writes flags as booleans and text verbatim', async () => {
    const { sheets, writer } = setup();
    writer.record(submission({ bound: false, fuzzy_match: true, message_text: '=HYPERLINK("http://x")', uid: '000123' }));
    await writer.flush();
    const [row] = sheets.dataRows(TABS.submissions);
    expect(row![SUBMISSION_HEADERS.indexOf('bound')]).toBe(false);
    expect(row![SUBMISSION_HEADERS.indexOf('fuzzy_match')]).toBe(true);
    expect(row![SUBMISSION_HEADERS.indexOf('message_text')]).toBe('=HYPERLINK("http://x")');
    expect(row![SUBMISSION_HEADERS.indexOf('uid')]).toBe('000123');
  });

  it('records a given row id only once (e.g. a message delivered twice)', () => {
    const { wal, writer } = setup();
    const entry = submission();
    expect(writer.record(entry)).toBe(true);
    expect(writer.record(entry)).toBe(false);
    expect(new WriteAheadLog(wal.path).read().pending).toHaveLength(1);
  });

  it('creates its tab with the exact headers, and never creates or touches a Binds tab', async () => {
    const { sheets, writer } = setup();
    writer.record(submission());
    await writer.flush();
    expect(sheets.tabs.get('Submissions')![0]).toEqual([...SUBMISSION_HEADERS]);
    expect(sheets.tabs.has('Binds')).toBe(false);
  });
});

describe('SheetWriter: failures', () => {
  it('retries after 1s, 4s and 16s', async () => {
    const { sheets, writer, sleeps } = setup();
    sheets.failNext(3, { op: 'appendRows' });
    writer.record(submission());
    await writer.flush();
    expect(sleeps).toEqual([1_000, 4_000, 16_000]);
    expect(sheets.dataRows(TABS.submissions)).toHaveLength(1);
  });

  it('does not duplicate rows when a failed append had actually gone through', async () => {
    const { sheets, writer } = setup();
    sheets.failNext(1, { op: 'appendRows', applied: true });
    writer.record(submission());
    writer.record(submission());
    await writer.flush();
    expect(sheets.dataRows(TABS.submissions)).toHaveLength(2);
    expect(writer.stats.skippedExisting).toBe(2);
  });

  it('keeps rows in the log while Sheets is down, pauses, and replays them after a restart', async () => {
    const { wal, sheets, writer, sleeps } = setup();
    sheets.failNext(Number.POSITIVE_INFINITY);
    const rows = [submission(), submission(), submission()];
    for (const row of rows) writer.record(row);
    await writer.flush();

    expect(sleeps).toEqual([1_000, 4_000, 16_000]);
    expect(writer.pendingCount).toBe(3);
    expect(new WriteAheadLog(wal.path).read().pending.map((e) => e.id)).toEqual(rows.map((r) => r.id));

    // Paused: a flush right after the failure does not touch Sheets.
    const callsBefore = sheets.calls.length;
    await writer.flush();
    expect(sheets.calls.length).toBe(callsBefore);

    sheets.recover();
    const { writer: after, wal: reopened } = restart(wal, sheets);
    expect(after.pendingCount).toBe(3);
    await expect(after.drainAll()).resolves.toBe(true);
    expect(sheets.dataRows(TABS.submissions)).toHaveLength(3);
    expect(new WriteAheadLog(reopened.path).read().pending).toHaveLength(0);
  });

  it('replays without duplicates when it crashed between the sheet write and the ack', async () => {
    const { wal, sheets } = setup();
    // First run: rows reach the sheet but the ack is never recorded.
    const crashy = new SheetWriter({
      gateway: sheets,
      wal: { append: (e: WalEntry) => wal.append(e), ack: () => { throw new Error('killed before ack'); } },
      tabs: TABS,
      flushIntervalMs: 5_000,
      flushMaxRows: 20,
      log: silentLogger,
    });
    const rows = [submission(), submission(), submission()];
    for (const row of rows) crashy.record(row);
    await crashy.flush();
    expect(sheets.dataRows(TABS.submissions)).toHaveLength(3);

    const { writer, wal: reopened } = restart(wal, sheets);
    expect(writer.pendingCount).toBe(3);
    await writer.drainAll();
    expect(sheets.dataRows(TABS.submissions)).toHaveLength(3);
    expect(writer.stats.skippedExisting).toBe(3);
    expect(new WriteAheadLog(reopened.path).read().pending).toHaveLength(0);
  });

  it('writes the rows a replay finds missing and skips the ones already present', async () => {
    const { wal, sheets, writer } = setup();
    const written = submission();
    writer.record(written);
    await writer.flush();
    // Simulate a lost ack for `written` plus one row that never made it.
    const missing = submission();
    wal.append(missing);
    const log = new WriteAheadLog(wal.path);
    const state = log.read();
    state.pending.unshift(written);

    const replayer = new SheetWriter({ gateway: sheets, wal, tabs: TABS, flushIntervalMs: 5_000, flushMaxRows: 20, log: silentLogger });
    replayer.restore(state);
    await replayer.drainAll();
    expect(links(sheets)).toEqual([written, missing].map((r) => (r.kind === 'submission' ? r.row.message_link : '')));
  });

  it('recreates a tab deleted while the bot runs, without a restart', async () => {
    const { sheets, writer } = setup();
    writer.record(submission());
    await writer.flush();
    sheets.tabs.delete(TABS.submissions); // someone deletes the tab mid-campaign
    writer.record(submission());
    await writer.flush();
    expect(sheets.tabs.get(TABS.submissions)?.[0]).toEqual([...SUBMISSION_HEADERS]);
    expect(sheets.dataRows(TABS.submissions)).toHaveLength(1);
  });

  it('stops writing, and keeps the rows, when a column is inserted mid-run', async () => {
    const { sheets, writer } = setup();
    writer.record(submission());
    await writer.flush();
    for (const row of sheets.tabs.get(TABS.submissions)!) row.splice(2, 0, 'notes'); // column inserted at C
    writer.record(submission());
    await writer.flush();
    expect(sheets.callsOf('appendRows')).toHaveLength(1);
    expect(writer.pendingCount).toBe(1);

    for (const row of sheets.tabs.get(TABS.submissions)!) row.splice(2, 1); // reviewer moves it back
    await expect(writer.drainAll()).resolves.toBe(true);
    expect(sheets.dataRows(TABS.submissions)).toHaveLength(2);
  });

  it('prepare() reports an unusable sheet instead of throwing, and a usable one as ready', async () => {
    const { sheets, writer } = setup();
    sheets.tabs.set(TABS.submissions, [['wrong']]);
    await expect(writer.prepare()).resolves.toBe(false);
    sheets.tabs.set(TABS.submissions, [[...SUBMISSION_HEADERS]]);
    await expect(writer.prepare()).resolves.toBe(true);
  });

  it('refuses to write under mismatched headers and keeps the rows', async () => {
    const { sheets, writer } = setup();
    sheets.tabs.set('Submissions', [['something', 'else']]);
    writer.record(submission());
    await writer.flush();
    expect(sheets.callsOf('appendRows')).toHaveLength(0);
    expect(writer.pendingCount).toBe(1);

    sheets.tabs.set('Submissions', [[...SUBMISSION_HEADERS]]);
    await expect(writer.drainAll()).resolves.toBe(true);
    expect(sheets.dataRows(TABS.submissions)).toHaveLength(1);
  });
});

describe('SheetWriter: a sheet from before Telegram support', () => {
  const OLD_SUBMISSION_HEADERS = [...SUBMISSION_UPGRADE_FROM[0]!];
  const OLD_BIND_HEADERS = ['timestamp_utc', 'discord_user_id', 'discord_username', 'uid', 'duplicate_uid', 'last_updated_utc'];
  const oldSubmission = ['2026-01-01T00:00:00Z', '100000000000000001', 'old_member', '111111', true, 'daily_check_in', false, 'submissions', 'old text', 'https://cdn.example.com/o.png', '', 'https://discord.com/channels/1/2/9', '2026-01-01'];
  const oldBind = ['2026-01-01T00:00:00Z', '100000000000000001', 'old_member', '111111', false, '2026-01-01T00:00:00Z'];

  it('writes the new headers over the old ones by itself and leaves every existing row alone', async () => {
    const { sheets, writer } = setup();
    sheets.tabs.set('Submissions', [OLD_SUBMISSION_HEADERS, oldSubmission]);
    sheets.tabs.set('Binds', [OLD_BIND_HEADERS, oldBind]);
    writer.record(submission());
    await writer.flush();

    expect(sheets.tabs.get('Submissions')![0]).toEqual([...SUBMISSION_HEADERS]);
    expect(sheets.tabs.get('Binds')![0]).toEqual(OLD_BIND_HEADERS); // the Binds tab is the Discord bot's: left exactly as it was
    expect(sheets.dataRows('Submissions')).toHaveLength(2);
    expect(sheets.dataRows('Submissions')[0]).toEqual(oldSubmission);
    expect(sheets.dataRows('Binds')).toEqual([oldBind]);
    // The new row carries the platform in the new last column.
    expect(sheets.dataRows('Submissions')[1]).toHaveLength(14);
    expect(sheets.dataRows('Submissions')[1]![13]).toBe('discord');
  });

  it('also accepts headers that were renamed by hand before the platform column was added', async () => {
    const { sheets, writer } = setup();
    sheets.tabs.set('Submissions', [[...SUBMISSION_HEADERS.slice(0, 13)], oldSubmission]);
    writer.record(submission());
    await writer.flush();
    expect(sheets.tabs.get('Submissions')![0]).toEqual([...SUBMISSION_HEADERS]);
    expect(sheets.dataRows('Submissions')).toHaveLength(2);
  });

  it('refuses to overwrite a reviewer column sitting where the platform column goes', async () => {
    const { sheets, writer } = setup();
    sheets.tabs.set('Submissions', [[...OLD_SUBMISSION_HEADERS, 'my review notes'], oldSubmission]);
    writer.record(submission());
    await writer.flush();
    expect(sheets.tabs.get('Submissions')![0]![13]).toBe('my review notes');
    expect(sheets.callsOf('appendRows')).toHaveLength(0);
    expect(writer.pendingCount).toBe(1);
  });

  it('keeps writing after the upgrade without upgrading again', async () => {
    const { sheets, writer } = setup();
    sheets.tabs.set('Submissions', [OLD_SUBMISSION_HEADERS]);
    writer.record(submission());
    await writer.flush();
    writer.record(submission());
    await writer.flush();
    expect(sheets.dataRows('Submissions')).toHaveLength(2);
    expect(sheets.tabs.get('Submissions')![0]).toEqual([...SUBMISSION_HEADERS]);
  });

});

describe('SheetWriter: two platforms', () => {
  it('writes a Telegram submission with its platform in the last column', async () => {
    const { sheets, writer } = setup();
    writer.record(submission({ platform: 'telegram', channel_name: 'telegram_dm', attachment_url: 'AgACAgIAAxkBAAI' }));
    await writer.flush();
    const [row] = sheets.dataRows('Submissions');
    expect(row![SUBMISSION_HEADERS.indexOf('platform')]).toBe('telegram');
    expect(row![SUBMISSION_HEADERS.indexOf('channel_name')]).toBe('telegram_dm');
  });
});
