import { type SheetsGateway, type TabSpec, compareHeaders } from '../src/sheets/gateway.js';
import type { Cell, SubmissionRow } from '../src/sheets/schema.js';
import type { WalEntry } from '../src/wal.js';

type Op = 'prepareTabs' | 'checkHeaders' | 'appendRows' | 'readRows' | 'readColumn' | 'updateRows';

interface Failure {
  op: Op | undefined;
  remaining: number;
  /** The call takes effect before the error is thrown, like a response lost in transit. */
  applied: boolean;
}

/** In-memory spreadsheet. Row 0 of each tab is the header row. */
export class FakeSheets implements SheetsGateway {
  readonly tabs = new Map<string, Cell[][]>();
  readonly calls: { op: Op; tab?: string; rows?: number }[] = [];
  private failures: Failure[] = [];

  failNext(count: number, options: { op?: Op; applied?: boolean } = {}): void {
    this.failures.push({ op: options.op, remaining: count, applied: options.applied ?? false });
  }

  recover(): void {
    this.failures = [];
  }

  dataRows(tab: string): Cell[][] {
    return (this.tabs.get(tab) ?? []).slice(1);
  }

  callsOf(op: Op): { op: Op; tab?: string; rows?: number }[] {
    return this.calls.filter((c) => c.op === op);
  }

  /** Same decision as the real gateway (it is the same function): create, initialise, upgrade, or refuse. */
  prepareTabs(tabs: readonly TabSpec[]): Promise<string[]> {
    return this.run('prepareTabs', undefined, undefined, () => {
      for (const tab of tabs) if (!this.tabs.has(tab.name)) this.tabs.set(tab.name, []);
      const { empty, upgrade } = compareHeaders(tabs, tabs.map((tab) => this.headerRow(tab.name)));
      return this.writeHeaders([...empty, ...upgrade]);
    });
  }

  checkHeaders(tabs: readonly TabSpec[]): Promise<string[]> {
    return this.run('checkHeaders', undefined, undefined, () => {
      for (const tab of tabs) {
        if (this.headerRow(tab.name).length === 0) throw new Error(`tab ${tab.name} missing or empty`);
      }
      return this.writeHeaders(compareHeaders(tabs, tabs.map((tab) => this.headerRow(tab.name))).upgrade);
    });
  }

  private headerRow(tab: string): string[] {
    return (this.tabs.get(tab)?.[0] ?? []).map((cell) => display(cell).trim());
  }

  private writeHeaders(tabs: readonly TabSpec[]): string[] {
    for (const tab of tabs) {
      const table = this.tabs.get(tab.name)!;
      table[0] = [...tab.headers];
    }
    return tabs.map((tab) => tab.name);
  }

  appendRows(tab: string, _width: number, rows: Cell[][]): Promise<void> {
    return this.run('appendRows', tab, rows.length, () => {
      this.table(tab).push(...rows.map((r) => [...r]));
    });
  }

  readRows(tab: string, width: number): Promise<string[][]> {
    return this.run('readRows', tab, undefined, () =>
      this.table(tab)
        .slice(1)
        .map((row) => Array.from({ length: width }, (_, i) => display(row[i]))),
    );
  }

  readColumn(tab: string, column: number): Promise<string[]> {
    return this.run('readColumn', tab, undefined, () =>
      this.table(tab)
        .slice(1)
        .map((row) => display(row[column])),
    );
  }

  updateRows(tab: string, _width: number, updates: { rowNumber: number; cells: Cell[] }[]): Promise<void> {
    return this.run('updateRows', tab, updates.length, () => {
      const table = this.table(tab);
      for (const u of updates) table[u.rowNumber - 1] = [...u.cells];
    });
  }

  private table(tab: string): Cell[][] {
    const table = this.tabs.get(tab);
    if (!table) throw new Error(`no such tab: ${tab}`);
    return table;
  }

  private run<T>(op: Op, tab: string | undefined, rows: number | undefined, apply: () => T): Promise<T> {
    this.calls.push({ op, tab, rows });
    const failure = this.failures.find((f) => f.remaining > 0 && (f.op === undefined || f.op === op));
    if (failure) {
      failure.remaining--;
      if (failure.applied) apply();
      return Promise.reject(Object.assign(new Error(`simulated ${op} failure`), { status: 503 }));
    }
    try {
      return Promise.resolve(apply());
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }
}

function display(cell: Cell | undefined): string {
  if (cell === undefined) return '';
  if (typeof cell === 'boolean') return cell ? 'TRUE' : 'FALSE';
  return cell;
}

let sequence = 0;

export function submission(overrides: Partial<SubmissionRow> = {}): WalEntry {
  sequence++;
  const messageId = `1300000000000${String(sequence).padStart(6, '0')}`;
  return {
    id: `sub:${messageId}`,
    kind: 'submission',
    row: {
      timestamp_utc: '2026-01-15T10:00:00Z',
      user_id: '100000000000000001',
      username: 'member_one',
      uid: '123456',
      bound: true,
      quest_type: 'daily_check_in',
      fuzzy_match: false,
      channel_name: 'submissions',
      message_text: 'daily check-in done',
      attachment_url: 'https://cdn.example.com/a.png',
      link_url: '',
      message_link: `https://discord.com/channels/1/2/${messageId}`,
      date_utc: '2026-01-15',
      platform: 'discord',
      ...overrides,
    },
  };
}
