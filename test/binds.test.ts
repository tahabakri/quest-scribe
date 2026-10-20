import { afterEach, describe, expect, it, vi } from 'vitest';
import { BindStore, keepBindsFresh, normalizeBindId } from '../src/binds.js';
import type { BindRow } from '../src/sheets/schema.js';

const A = '100000000000000001';
const B = '100000000000000002';
const T1 = new Date('2026-01-01T10:00:00.123Z');
const T2 = new Date('2026-01-02T11:30:00.999Z');

function bindNow(store: BindStore, user: string, uid: string, at = T1): BindRow {
  const row = store.prepare('discord', user, `user_${user.slice(-1)}`, uid, at);
  store.apply(row);
  return row;
}

describe('BindStore', () => {
  it('prepares a row without applying it', () => {
    const store = new BindStore();
    const row = store.prepare('discord', A, 'member_a', '123456', T1);
    expect(row).toEqual({
      timestamp_utc: '2026-01-01T10:00:00Z',
      user_id: A,
      username: 'member_a',
      uid: '123456',
      duplicate_uid: false,
      last_updated_utc: '2026-01-01T10:00:00Z',
      platform: 'discord',
    });
    expect(store.lookup('discord', A)).toBeUndefined();
  });

  it('keeps the first-bound time and updates the rest when a user re-binds', () => {
    const store = new BindStore();
    bindNow(store, A, '111111', T1);
    const again = bindNow(store, A, '222222', T2);
    expect(again).toMatchObject({ timestamp_utc: '2026-01-01T10:00:00Z', uid: '222222', last_updated_utc: '2026-01-02T11:30:00Z' });
    expect(store.size).toBe(1);
  });

  it('flags a second user binding an ID someone else holds', () => {
    const store = new BindStore();
    expect(bindNow(store, A, '123456').duplicate_uid).toBe(false);
    expect(bindNow(store, B, '123456').duplicate_uid).toBe(true);
  });

  it('does not flag a user re-binding their own ID', () => {
    const store = new BindStore();
    bindNow(store, A, '123456');
    expect(bindNow(store, A, '123456').duplicate_uid).toBe(false);
  });

  it('stops counting an ID once its holder moves to another', () => {
    const store = new BindStore();
    bindNow(store, A, '123456');
    bindNow(store, A, '654321');
    expect(bindNow(store, B, '123456').duplicate_uid).toBe(false);
  });

  it('replace() takes the sheet as truth, then re-applies binds not yet written', () => {
    const store = new BindStore();
    bindNow(store, A, '999999'); // stale local state
    const sheet: BindRow[] = [store.prepare('discord', A, 'member_a', '111111', T1)];
    const pending: BindRow[] = [store.prepare('discord', B, 'member_b', '111111', T2)];
    store.replace(sheet, pending);
    expect(store.lookup('discord', A)?.uid).toBe('111111');
    expect(store.lookup('discord', B)?.uid).toBe('111111');
    expect(bindNow(store, B, '999999').duplicate_uid).toBe(false); // 999999 no longer held by A
  });

  it('replace() ignores a pending bind that is older than the sheet row', () => {
    const store = new BindStore();
    const sheet = [store.prepare('discord', A, 'member_a', '222222', T2)];
    const stale = store.prepare('discord', A, 'member_a', '111111', T1);
    store.replace(sheet, [stale]);
    expect(store.lookup('discord', A)?.uid).toBe('222222');
  });

  it('replace() keeps a user\'s first sheet row when there are several', () => {
    const store = new BindStore();
    const first = store.prepare('discord', A, 'member_a', '111111', T1);
    const second = store.prepare('discord', A, 'member_a', '222222', T2);
    store.replace([first, second]);
    expect(store.lookup('discord', A)?.uid).toBe('111111');
  });

  it('loadHistory() replays the log oldest-first, so the latest bind wins', () => {
    const store = new BindStore();
    store.loadHistory([store.prepare('discord', A, 'member_a', '111111', T1), store.prepare('discord', A, 'member_a', '222222', T2)]);
    expect(store.lookup('discord', A)?.uid).toBe('222222');
  });
});

describe('BindStore: two platforms', () => {
  const D = '555000555';
  it('keeps the same user ID on two platforms apart', () => {
    const store = new BindStore();
    store.apply(store.prepare('discord', D, 'on_discord', '111111', T1));
    expect(store.lookup('telegram', D)).toBeUndefined();
    store.apply(store.prepare('telegram', D, 'on_telegram', '222222', T1));
    expect(store.lookup('discord', D)?.uid).toBe('111111');
    expect(store.lookup('telegram', D)?.uid).toBe('222222');
    expect(store.size).toBe(2);
  });

  it('flags an ID held by someone on the other platform, in both directions', () => {
    const forward = new BindStore();
    forward.apply(forward.prepare('discord', A, 'd', '111111', T1));
    expect(forward.prepare('telegram', '777', 't', '111111', T2).duplicate_uid).toBe(true);

    const backward = new BindStore();
    backward.apply(backward.prepare('telegram', '777', 't', '111111', T1));
    expect(backward.prepare('discord', A, 'd', '111111', T2).duplicate_uid).toBe(true);
  });

  it('flags the same person binding the same ID on both platforms, for the reviewer to see', () => {
    const store = new BindStore();
    store.apply(store.prepare('discord', A, 'me', '111111', T1));
    expect(store.prepare('telegram', '777', 'me', '111111', T2)).toMatchObject({ duplicate_uid: true, platform: 'telegram' });
  });

  it('does not flag a member re-binding their own ID, on either platform', () => {
    const store = new BindStore();
    store.apply(store.prepare('telegram', '777', 't', '111111', T1));
    expect(store.prepare('telegram', '777', 't', '111111', T2).duplicate_uid).toBe(false);
  });

  it('is not confused by equal IDs when one of them moves to another UID', () => {
    const store = new BindStore();
    store.apply(store.prepare('discord', D, 'd', '111111', T1));
    store.apply(store.prepare('telegram', D, 't', '111111', T1));
    store.apply(store.prepare('telegram', D, 't', '222222', T2));
    // The Discord member still holds 111111, so a newcomer on 111111 is still a duplicate.
    expect(store.prepare('telegram', '888', 'x', '111111', T2).duplicate_uid).toBe(true);
    expect(store.prepare('telegram', '888', 'x', '222222', T2).duplicate_uid).toBe(true);
    expect(store.prepare('telegram', '888', 'x', '333333', T2).duplicate_uid).toBe(false);
  });

  it('replace() and loadHistory() keep the platforms apart', () => {
    const store = new BindStore();
    const sheet = [store.prepare('discord', D, 'd', '111111', T1), store.prepare('telegram', D, 't', '222222', T1)];
    store.replace(sheet);
    expect(store.lookup('discord', D)?.uid).toBe('111111');
    expect(store.lookup('telegram', D)?.uid).toBe('222222');
    store.loadHistory([store.prepare('telegram', D, 't', '333333', T2)]);
    expect(store.lookup('telegram', D)?.uid).toBe('333333');
    expect(store.lookup('discord', D)).toBeUndefined();
  });
});

describe('keepBindsFresh', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const results = (...outcomes: boolean[]) => {
    const refresh = vi.fn(() => Promise.resolve(outcomes.shift() ?? true));
    return refresh;
  };

  it('retries every 30s after a failed first load, then settles into the normal interval', async () => {
    vi.useFakeTimers();
    const refresh = results(false, false, true, true);
    keepBindsFresh({ refresh, loaded: false, intervalMs: 600_000, retryMs: 30_000, onError: () => {} });
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(refresh).toHaveBeenCalledTimes(3); // failed, failed, succeeded
    await vi.advanceTimersByTimeAsync(599_999);
    expect(refresh).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(4);
  });

  it('with periodic refresh off, still retries a failed first load until it succeeds', async () => {
    vi.useFakeTimers();
    const refresh = results(false, true);
    keepBindsFresh({ refresh, loaded: false, intervalMs: 0, retryMs: 30_000, onError: () => {} });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refresh).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('does nothing when loaded and periodic refresh is off', async () => {
    vi.useFakeTimers();
    const refresh = results();
    keepBindsFresh({ refresh, loaded: true, intervalMs: 0, retryMs: 30_000, onError: () => {} });
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('treats a thrown refresh as a failure and keeps going', async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const refresh = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(true);
    keepBindsFresh({ refresh, loaded: false, intervalMs: 600_000, retryMs: 30_000, onError });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});

describe('normalizeBindId', () => {
  it.each([
    ['  123456  ', '123456'],
    ['１２３４５６', '123456'], // full-width
    ['١٢٣٤٥٦', '123456'], // Arabic-Indic
    ['۱۲۳۴۵۶', '123456'], // Persian
  ])('%j -> %j', (raw, expected) => {
    expect(normalizeBindId(raw)).toBe(expected);
  });
});
