import { auth, sheets, type sheets_v4 } from '@googleapis/sheets';
import type { Cell } from './schema.js';

export interface TabSpec {
  name: string;
  headers: readonly string[];
  /**
   * Older layouts of this tab that may still be in a sheet. When row 1 matches one
   * exactly, and the cells after it are empty, row 1 is rewritten to `headers`.
   */
  upgradeFrom?: readonly (readonly string[])[];
}

/** The handful of Sheets operations the bot needs. Faked in tests. */
export interface SheetsGateway {
  /**
   * Creates missing tabs, writes headers into empty ones and upgrades recognised
   * older layouts. Throws HeaderMismatchError if row 1 is anything else. Returns
   * the names of the tabs whose headers it wrote.
   */
  prepareTabs(tabs: readonly TabSpec[]): Promise<string[]>;
  /**
   * One read: throws HeaderMismatchError if row 1 differs, or an Error if a tab or
   * its headers are gone. Recognised older layouts are upgraded, as in prepareTabs.
   */
  checkHeaders(tabs: readonly TabSpec[]): Promise<string[]>;
  /** Appends rows after the last row of the tab's table. */
  appendRows(tab: string, width: number, rows: Cell[][]): Promise<void>;
  /** Data rows (row 2 onwards) as displayed strings, padded to `width`. */
  readRows(tab: string, width: number): Promise<string[][]>;
  /** One column (0-based index) from row 2 onwards. */
  readColumn(tab: string, column: number): Promise<string[]>;
  /** Overwrites whole rows in place. `rowNumber` is the 1-based sheet row. */
  updateRows(tab: string, width: number, updates: { rowNumber: number; cells: Cell[] }[]): Promise<void>;
}

/** Row 1 of a tab does not match the expected headers. Writing would scramble columns, so it is never retried blindly. */
export class HeaderMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HeaderMismatchError';
  }
}

export interface ServiceAccountCredentials {
  client_email: string;
  private_key: string;
}

export interface GoogleSheetsOptions {
  spreadsheetId: string;
  credentials: ServiceAccountCredentials;
  timeoutMs?: number;
}

export function createGoogleSheetsGateway(options: GoogleSheetsOptions): SheetsGateway {
  const client = new auth.GoogleAuth({
    credentials: options.credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  // Retries are owned by the writer (1s/4s/16s), so the HTTP client never retries on its own.
  const api: sheets_v4.Sheets = sheets({
    version: 'v4',
    auth: client,
    timeout: options.timeoutMs ?? 20_000,
    retry: false,
  });
  const spreadsheetId = options.spreadsheetId;

  return {
    async prepareTabs(tabs) {
      const meta = await api.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties.title' });
      const existing = new Set((meta.data.sheets ?? []).map((s) => s.properties?.title));
      const missing = tabs.filter((tab) => !existing.has(tab.name));
      if (missing.length > 0) {
        await api.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: { requests: missing.map((tab) => ({ addSheet: { properties: { title: tab.name } } })) },
        });
      }

      const { empty, upgrade } = compareHeaders(tabs, await readHeaderRows(api, spreadsheetId, tabs));
      return writeHeaders(api, spreadsheetId, [...empty, ...upgrade]);
    },

    async checkHeaders(tabs) {
      const { empty, upgrade } = compareHeaders(tabs, await readHeaderRows(api, spreadsheetId, tabs));
      if (empty.length > 0) {
        throw new Error(`row 1 of "${empty.map((t) => t.name).join('", "')}" is empty; headers will be rewritten`);
      }
      return writeHeaders(api, spreadsheetId, upgrade);
    },

    async appendRows(tab, width, rows) {
      await api.spreadsheets.values.append({
        spreadsheetId,
        range: `${quoteTab(tab)}!A:${columnLetter(width - 1)}`,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { majorDimension: 'ROWS', values: rows },
      });
    },

    async readRows(tab, width) {
      const res = await api.spreadsheets.values.get({
        spreadsheetId,
        range: `${quoteTab(tab)}!A2:${columnLetter(width - 1)}`,
      });
      return (res.data.values ?? []).map((row) =>
        Array.from({ length: width }, (_, i) => (row[i] === undefined || row[i] === null ? '' : String(row[i]))),
      );
    },

    async readColumn(tab, column) {
      const letter = columnLetter(column);
      const res = await api.spreadsheets.values.get({ spreadsheetId, range: `${quoteTab(tab)}!${letter}2:${letter}` });
      return (res.data.values ?? []).map((row) => (row[0] === undefined || row[0] === null ? '' : String(row[0])));
    },

    async updateRows(tab, width, updates) {
      await api.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: {
          valueInputOption: 'RAW',
          data: updates.map((u) => ({
            range: `${quoteTab(tab)}!A${u.rowNumber}:${columnLetter(width - 1)}${u.rowNumber}`,
            values: [u.cells],
          })),
        },
      });
    },
  };
}

async function readHeaderRows(
  api: sheets_v4.Sheets,
  spreadsheetId: string,
  tabs: readonly TabSpec[],
): Promise<string[][]> {
  const res = await api.spreadsheets.values.batchGet({
    spreadsheetId,
    ranges: tabs.map((tab) => `${quoteTab(tab.name)}!1:1`),
  });
  return tabs.map((_, i) => (res.data.valueRanges?.[i]?.values?.[0] ?? []).map((cell) => String(cell).trim()));
}

/** Writes `tabs`' headers into row 1 (RAW) and returns their names. */
async function writeHeaders(api: sheets_v4.Sheets, spreadsheetId: string, tabs: readonly TabSpec[]): Promise<string[]> {
  if (tabs.length === 0) return [];
  await api.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: 'RAW',
      data: tabs.map((tab) => ({
        range: `${quoteTab(tab.name)}!A1:${columnLetter(tab.headers.length - 1)}1`,
        values: [[...tab.headers]],
      })),
    },
  });
  return tabs.map((tab) => tab.name);
}

const sameCells = (a: readonly string[], b: readonly string[]): boolean => a.join('\u0000') === b.join('\u0000');

/**
 * Sorts the tabs by what row 1 holds: `empty` (to be initialised), `upgrade` (a
 * recognised older layout, to be rewritten), or fine. Throws HeaderMismatchError
 * for anything else. Extra columns to the right of the headers are fine.
 */
export function compareHeaders(tabs: readonly TabSpec[], rows: string[][]): { empty: TabSpec[]; upgrade: TabSpec[] } {
  const empty: TabSpec[] = [];
  const upgrade: TabSpec[] = [];
  const problems: string[] = [];
  tabs.forEach((tab, i) => {
    const row = rows[i] ?? [];
    if (row.every((cell) => cell === '')) {
      empty.push(tab);
      return;
    }
    if (sameCells(row.slice(0, tab.headers.length), tab.headers)) return;
    // An older layout, and nothing in the columns the new layout adds, so rewriting row 1 loses nothing.
    const older = (tab.upgradeFrom ?? []).some(
      (layout) => sameCells(row.slice(0, layout.length), layout) && row.slice(layout.length, tab.headers.length).every((c) => c === ''),
    );
    if (older) {
      upgrade.push(tab);
      return;
    }
    problems.push(`tab "${tab.name}" row 1 is [${row.slice(0, tab.headers.length).join(', ')}], expected [${tab.headers.join(', ')}]`);
  });
  if (problems.length > 0) throw new HeaderMismatchError(`Sheet headers do not match: ${problems.join('; ')}`);
  return { empty, upgrade };
}

/** A1-notation tab reference; always quoted so names with spaces or quotes work. */
export function quoteTab(name: string): string {
  return `'${name.replace(/'/g, "''")}'`;
}

/** 0 -> A, 25 -> Z, 26 -> AA. */
export function columnLetter(index: number): string {
  let n = index + 1;
  let letters = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}
