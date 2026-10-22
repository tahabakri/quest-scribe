import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WriteAheadLog } from '../src/wal.js';
import { submission } from './fakes.js';

const open: WriteAheadLog[] = [];

function freshLog(): WriteAheadLog {
  const wal = new WriteAheadLog(join(mkdtempSync(join(tmpdir(), 'ql-wal-')), 'data', 'fallback.jsonl'));
  open.push(wal);
  return wal;
}

afterEach(() => {
  for (const wal of open.splice(0)) wal.close();
});

describe('WriteAheadLog', () => {
  it('starts empty and creates its directory', () => {
    const wal = freshLog();
    expect(wal.open()).toMatchObject({ pending: [], corruptLines: 0 });
  });

  it('returns only unacknowledged rows, in write order', () => {
    const wal = freshLog();
    wal.open();
    const [a, b, c] = [submission(), submission(), submission()];
    wal.append(a);
    wal.append(b);
    wal.append(c);
    wal.ack([a.id]);

    const state = new WriteAheadLog(wal.path).read();
    expect(state.pending.map((e) => e.id)).toEqual([b.id, c.id]);
    expect(state.knownIds).toEqual(new Set([a.id, b.id, c.id]));
  });

  it('survives a write torn by a crash, and keeps later writes readable', () => {
    const wal = freshLog();
    wal.open();
    const before = submission();
    wal.append(before);
    wal.close();
    appendFileSync(wal.path, '{"type":"row","id":"sub:torn","kind":"submis'); // crash mid-write

    const reopened = new WriteAheadLog(wal.path);
    open.push(reopened);
    const state = reopened.open();
    expect(state.corruptLines).toBe(1);
    expect(state.pending.map((e) => e.id)).toEqual([before.id]);

    const after = submission();
    reopened.append(after);
    const final = new WriteAheadLog(wal.path).read();
    expect(final.pending.map((e) => e.id)).toEqual([before.id, after.id]);
    expect(final.corruptLines).toBe(1);
  });

  it('treats a repeated row id as one row', () => {
    const wal = freshLog();
    wal.open();
    const entry = submission();
    wal.append(entry);
    wal.append({ ...entry, row: { ...entry.row, message_text: 'second copy' } });
    const state = new WriteAheadLog(wal.path).read();
    expect(state.pending).toHaveLength(1);
    expect(state.pending[0]).toEqual(entry);
  });

  it('writes one self-describing JSON object per line', () => {
    const wal = freshLog();
    wal.open();
    const entry = submission();
    wal.append(entry);
    wal.ack([entry.id]);
    const lines = readFileSync(wal.path, 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines[0]).toMatchObject({ type: 'row', id: entry.id, kind: 'submission', row: entry.row });
    expect(lines[1]).toMatchObject({ type: 'ack', ids: [entry.id] });
  });

  it('refuses to append before it is opened', () => {
    expect(() => freshLog().append(submission())).toThrow(/not open/);
  });
});

describe('WriteAheadLog: a log written before Telegram support', () => {
  const legacySubmission = {
    type: 'row',
    written_at: '2026-10-09T10:00:00.000Z',
    id: 'sub:1',
    kind: 'submission',
    row: {
      timestamp_utc: '2026-10-09T10:00:00Z',
      discord_user_id: '100000000000000001',
      discord_username: 'old_member',
      uid: '111111',
      bound: true,
      quest_type: 'daily_check_in',
      fuzzy_match: false,
      channel_name: 'submissions',
      message_text: 'text',
      attachment_url: '',
      link_url: '',
      message_link: 'https://discord.com/channels/1/2/3',
      date_utc: '2026-10-09',
    },
  };
  it('maps the old Discord-only keys to the current ones and marks the rows as Discord', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ql-wal-legacy-')), 'fallback.jsonl');
    writeFileSync(path, [legacySubmission].map((l) => JSON.stringify(l)).join('\n') + '\n');
    const state = new WriteAheadLog(path).read();

    expect(state.corruptLines).toBe(0);
    expect(state.pending.map((e) => e.id)).toEqual(['sub:1']);
    expect(state.pending[0]!.row).toMatchObject({ user_id: '100000000000000001', username: 'old_member', platform: 'discord' });
    expect(state.pending[0]!.row).not.toHaveProperty('discord_user_id');
  });

  it('leaves current-format rows, including Telegram ones, exactly as they are', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ql-wal-current-')), 'fallback.jsonl');
    const telegram = submission({ user_id: '777', platform: 'telegram' });
    const wal = new WriteAheadLog(path);
    wal.open();
    wal.append(telegram);
    wal.close();
    expect(new WriteAheadLog(path).read().pending[0]).toEqual(telegram);
  });
});
