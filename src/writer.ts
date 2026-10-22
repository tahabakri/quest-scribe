import { setTimeout as delay } from 'node:timers/promises';
import type { Logger } from './logger.js';
import { HeaderMismatchError, type SheetsGateway } from './sheets/gateway.js';
import {
  MESSAGE_LINK_COLUMN,
  SUBMISSION_HEADERS,
  SUBMISSION_UPGRADE_FROM,
  submissionCells,
} from './sheets/schema.js';
import type { WalEntry, WalState, WriteAheadLog } from './wal.js';

export interface WriterOptions {
  gateway: SheetsGateway;
  wal: Pick<WriteAheadLog, 'append' | 'ack'>;
  tabs: { submissions: string };
  /** Flush at least this often... */
  flushIntervalMs: number;
  /** ...or as soon as this many rows are waiting. */
  flushMaxRows: number;
  log: Logger;
  /** Waits between attempts of one batch. Default 1s, 4s, 16s (so four attempts). */
  retryDelaysMs?: readonly number[];
  /** Upper bound on rows per Sheets request. */
  maxBatchRows?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface WriterStats {
  appended: number;
  skippedExisting: number;
  failedFlushes: number;
}

interface Queued {
  entry: WalEntry;
  /** True when the row may already be in the sheet (restored from the log, or its last attempt errored). */
  verify: boolean;
}

const MIN_COOLDOWN_MS = 30_000;
const MAX_COOLDOWN_MS = 300_000;

/**
 * Durable, batched writer for the Submissions tab. It never touches the Binds tab.
 *
 * - record() appends to the write-ahead log (fsynced) before anything else, so
 *   an accepted row survives crashes, restarts and Sheets outages.
 * - Rows are flushed every `flushIntervalMs` or once `flushMaxRows` are waiting,
 *   one values.append per batch.
 * - A failed batch is retried after 1s, 4s and 16s. If it still fails, rows stay
 *   queued (and in the log) and the writer pauses 30s-5min before trying again.
 * - Any Sheets call that errors may still have been applied, so rows from a
 *   failed attempt, and rows restored from the log at startup, are checked
 *   against the sheet's message_link column first.
 */
export class SheetWriter {
  readonly stats: WriterStats = { appended: 0, skippedExisting: 0, failedFlushes: 0 };

  private queue: Queued[] = [];
  private readonly known = new Set<string>();
  private ready = false;
  private chain: Promise<unknown> = Promise.resolve();
  private scheduledFlush: Promise<void> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private cooldownUntil = 0;
  private cooldownMs = 0;

  private readonly gateway: SheetsGateway;
  private readonly log: Logger;
  private readonly retryDelays: readonly number[];
  private readonly maxBatchRows: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly options: WriterOptions) {
    this.gateway = options.gateway;
    this.log = options.log;
    this.retryDelays = options.retryDelaysMs ?? [1_000, 4_000, 16_000];
    this.maxBatchRows = options.maxBatchRows ?? 500;
    this.sleep = options.sleep ?? ((ms) => delay(ms));
    this.now = options.now ?? Date.now;
  }

  /** Re-queues rows the log says never reached the sheet. */
  restore(state: WalState): void {
    for (const id of state.knownIds) this.known.add(id);
    for (const entry of state.pending) this.queue.push({ entry, verify: true });
  }

  /** True if a row with this id was already recorded (this run, or in the log from an earlier one). */
  has(id: string): boolean {
    return this.known.has(id);
  }

  /**
   * Makes a row durable and queues it. Throws if the log cannot be written (the
   * caller must then treat the row as not saved). Returns false if this row id
   * was already recorded, e.g. the same chat message delivered twice.
   */
  record(entry: WalEntry): boolean {
    if (this.known.has(entry.id)) return false;
    this.options.wal.append(entry);
    this.known.add(entry.id);
    this.queue.push({ entry, verify: false });
    if (this.queue.length >= this.options.flushMaxRows) void this.flush();
    return true;
  }

  get pendingCount(): number {
    return this.queue.length;
  }

  start(): void {
    this.timer ??= setInterval(() => void this.flush(), this.options.flushIntervalMs);
    this.timer.unref();
  }

  /** Writes queued rows unless paused after a failure. Calls made while one is waiting to run share it. */
  flush(): Promise<void> {
    this.scheduledFlush ??= this.exclusive(async () => {
      this.scheduledFlush = undefined;
      await this.drain({ force: false, retries: true });
    });
    return this.scheduledFlush;
  }

  /** Writes everything now, ignoring any pause. Resolves true when nothing is left queued. */
  drainAll(): Promise<boolean> {
    return this.exclusive(() => this.drain({ force: true, retries: true }));
  }

  /**
   * Checks that the sheet is reachable and its headers are right, creating the tab
   * and writing the headers if needed. Returns false (and logs why) if it is not usable.
   */
  async prepare(): Promise<boolean> {
    return this.exclusive(async () => {
      try {
        await this.ensureReady();
        return true;
      } catch (err) {
        this.ready = false;
        if (err instanceof HeaderMismatchError) {
          this.log.error('refusing to write: fix the sheet headers; rows will wait in the write-ahead log', { err });
        } else {
          this.log.warn('could not reach the sheet; rows will wait in the write-ahead log', { err });
        }
        return false;
      }
    });
  }

  /** Stops the timer and makes one last attempt (no retries) within `timeoutMs`. Unwritten rows stay in the log. */
  async stop(timeoutMs = 8_000): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const final = this.exclusive(() => this.drain({ force: true, retries: false }));
    await Promise.race([final, delay(timeoutMs, undefined, { ref: false })]);
  }

  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async drain(opts: { force: boolean; retries: boolean }): Promise<boolean> {
    while (this.queue.length > 0) {
      if (!opts.force && this.now() < this.cooldownUntil) return false;
      const batch = this.queue.slice(0, this.maxBatchRows);
      if (!(await this.writeBatch(batch, opts.retries))) {
        // Pausing only spaces out the timer-driven flushes; forced drains report back instead.
        if (!opts.force) this.pause();
        return false;
      }
      this.cooldownMs = 0;
      this.cooldownUntil = 0;
    }
    return true;
  }

  private async writeBatch(batch: Queued[], retries: boolean): Promise<boolean> {
    const submissions = batch;
    const delays = retries ? this.retryDelays : [];

    for (let attempt = 0; ; attempt++) {
      try {
        await this.ensureReady();
        await this.writeSubmissions(submissions);
        this.settle(submissions);
        return true;
      } catch (err) {
        for (const q of submissions) q.verify = true;
        // The sheet may have changed shape (tab deleted or renamed): re-prepare it next time.
        this.ready = false;
        const rows = submissions.length;
        if (err instanceof HeaderMismatchError) {
          this.log.error('refusing to write: fix the sheet headers; rows are safe in the write-ahead log', {
            rows,
            err,
          });
          return false;
        }
        const wait = delays[attempt];
        if (wait === undefined) {
          this.stats.failedFlushes++;
          this.log.error('Sheets write failed; rows are safe in the write-ahead log and will be retried', {
            rows,
            attempts: attempt + 1,
            err,
          });
          return false;
        }
        this.log.warn(`Sheets write failed, retrying in ${wait / 1000}s`, {
          attempt: attempt + 1,
          of: delays.length + 1,
          rows,
          err,
        });
        await this.sleep(wait);
      }
    }
  }

  /**
   * Before every batch: the first time (or after a failure), create the missing tab
   * and headers; otherwise re-check the headers with one read. Reviewers edit
   * these sheets, and a column inserted mid-run would otherwise shift every row
   * written after it into the wrong columns.
   */
  private async ensureReady(): Promise<void> {
    const tabs = [
      { name: this.options.tabs.submissions, headers: SUBMISSION_HEADERS, upgradeFrom: SUBMISSION_UPGRADE_FROM },
    ];
    const written = this.ready ? await this.gateway.checkHeaders(tabs) : await this.gateway.prepareTabs(tabs);
    this.ready = true;
    if (written.length > 0) this.log.info('wrote the current column headers to the sheet', { tabs: written.join(', ') });
  }

  private async writeSubmissions(items: Queued[]): Promise<void> {
    const tab = this.options.tabs.submissions;
    let toWrite = items;
    if (items.some((q) => q.verify)) {
      const existing = new Set(
        (await this.gateway.readColumn(tab, MESSAGE_LINK_COLUMN)).map((v) => v.trim()).filter((v) => v !== ''),
      );
      toWrite = items.filter((q) => !existing.has(q.entry.row.message_link));
      const skipped = items.length - toWrite.length;
      if (skipped > 0) {
        this.stats.skippedExisting += skipped;
        this.log.info('skipped rows already in the sheet', { rows: skipped });
      }
    }
    if (toWrite.length === 0) return;
    await this.gateway.appendRows(
      tab,
      SUBMISSION_HEADERS.length,
      toWrite.map((q) => submissionCells(q.entry.row)),
    );
    this.stats.appended += toWrite.length;
    this.log.info('wrote submissions to the sheet', { rows: toWrite.length });
  }

  /** Marks rows as safely in the sheet. */
  private settle(items: Queued[]): void {
    const ids = items.map((q) => q.entry.id);
    try {
      this.options.wal.ack(ids);
    } catch (err) {
      // The rows are in the sheet. On the next start they replay harmlessly: they are found by message_link and skipped.
      this.log.error('could not record acknowledgement in the write-ahead log', { rows: ids.length, err });
    }
    const done = new Set(ids);
    this.queue = this.queue.filter((q) => !done.has(q.entry.id));
  }

  private pause(): void {
    this.cooldownMs = Math.min(Math.max(this.cooldownMs * 2, MIN_COOLDOWN_MS), MAX_COOLDOWN_MS);
    this.cooldownUntil = this.now() + this.cooldownMs;
    this.log.warn(`pausing Sheets writes for ${this.cooldownMs / 1000}s`, { pending: this.queue.length });
  }
}
