import { type BindRow, type Platform, bindKey, isOlderBind, isoSeconds } from './sheets/schema.js';

/**
 * In-memory view of the Binds tab, so submissions never read the sheet.
 * Kept current by /bind itself, refreshed from the sheet on startup and every
 * few minutes (to pick up manual edits), with binds not yet written re-applied
 * on top so a refresh never loses one.
 *
 * Members are identified by platform plus user ID, so a Telegram ID can never
 * collide with a Discord one. IDs are shared across platforms, though: that is
 * what lets duplicate_uid catch the same ID bound by two different people, and
 * what makes the same person on both platforms show up for manual review.
 */
export class BindStore {
  private readonly byUser = new Map<string, BindRow>();
  /** uid -> the members (as bindKey) currently holding it. */
  private readonly usersByUid = new Map<string, Set<string>>();

  get size(): number {
    return this.byUser.size;
  }

  lookup(platform: Platform, userId: string): BindRow | undefined {
    return this.byUser.get(bindKey(platform, userId));
  }

  /**
   * The row a /bind would write, without applying it. duplicate_uid is TRUE when
   * the ID is currently bound to a different member, on either platform; the bind
   * still goes ahead and the flag is left for manual review.
   */
  prepare(platform: Platform, userId: string, username: string, uid: string, at: Date): BindRow {
    const now = isoSeconds(at);
    const me = bindKey(platform, userId);
    const holders = this.usersByUid.get(uid);
    return {
      timestamp_utc: this.byUser.get(me)?.timestamp_utc || now,
      user_id: userId,
      username,
      uid,
      duplicate_uid: holders !== undefined && [...holders].some((holder) => holder !== me),
      last_updated_utc: now,
      platform,
    };
  }

  apply(row: BindRow): void {
    const me = bindKey(row.platform, row.user_id);
    const previous = this.byUser.get(me);
    if (previous) {
      const holders = this.usersByUid.get(previous.uid);
      holders?.delete(me);
      if (holders?.size === 0) this.usersByUid.delete(previous.uid);
    }
    this.byUser.set(me, row);
    let holders = this.usersByUid.get(row.uid);
    if (!holders) {
      holders = new Set();
      this.usersByUid.set(row.uid, holders);
    }
    holders.add(me);
  }

  /**
   * Replaces the cache with the sheet's rows, then re-applies `pending` binds
   * that are newer than what the sheet holds (a stale bind replayed from the log
   * must not win). If a member somehow has several rows, the first is the one kept
   * up to date.
   */
  replace(sheetRows: readonly BindRow[], pending: readonly BindRow[] = []): void {
    this.byUser.clear();
    this.usersByUid.clear();
    for (const row of sheetRows) {
      if (!this.byUser.has(bindKey(row.platform, row.user_id))) this.apply(row);
    }
    for (const row of pending) {
      const current = this.byUser.get(bindKey(row.platform, row.user_id));
      if (!current || !isOlderBind(row.last_updated_utc, current.last_updated_utc)) this.apply(row);
    }
  }

  /** Rebuilds from the write-ahead log's bind history (oldest first), for when the sheet is unreachable. */
  loadHistory(rows: readonly BindRow[]): void {
    this.replace([], rows);
  }
}

/**
 * Keeps the bind cache in step with the sheet: every `intervalMs` (0 = only
 * until the first successful read), and every `retryMs` after a failed read,
 * so a Sheets blip at startup doesn't leave bound members looking unbound for
 * a whole interval. Returns a function that stops it.
 */
export function keepBindsFresh(options: {
  refresh: () => Promise<boolean>;
  /** Whether the sheet has already been read successfully. */
  loaded: boolean;
  intervalMs: number;
  retryMs: number;
  onError: (err: unknown) => void;
}): () => void {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const schedule = (loaded: boolean): void => {
    const wait = loaded ? options.intervalMs : options.retryMs;
    if (stopped || wait <= 0) return;
    timer = setTimeout(() => {
      options.refresh().then(schedule, (err: unknown) => {
        options.onError(err);
        schedule(false);
      });
    }, wait);
    timer.unref();
  };
  schedule(options.loaded);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

/**
 * Canonicalises a typed ID before validation: trims, folds full-width digits
 * (NFKC), and maps Arabic-Indic and Persian digits to ASCII, since members type
 * IDs on whatever keyboard they have.
 */
export function normalizeBindId(raw: string): string {
  return raw
    .normalize('NFKC')
    .trim()
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}
