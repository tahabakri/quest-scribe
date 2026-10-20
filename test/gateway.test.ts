import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  get: vi.fn(),
  batchUpdate: vi.fn(),
  values: { append: vi.fn(), get: vi.fn(), batchGet: vi.fn(), batchUpdate: vi.fn() },
  createClient: vi.fn(),
}));

vi.mock('@googleapis/sheets', () => ({
  auth: { GoogleAuth: class {} },
  sheets: (options: unknown) => {
    api.createClient(options);
    return { spreadsheets: { get: api.get, batchUpdate: api.batchUpdate, values: api.values } };
  },
}));

const { HeaderMismatchError, columnLetter, createGoogleSheetsGateway, quoteTab } = await import('../src/sheets/gateway.js');

const gateway = () =>
  createGoogleSheetsGateway({
    spreadsheetId: 'sheet-id',
    credentials: { client_email: 'bot@example.com', private_key: 'fake-key' },
  });

beforeEach(() => {
  vi.clearAllMocks();
  for (const fn of Object.values(api.values)) fn.mockResolvedValue({ data: {} });
  api.get.mockResolvedValue({ data: { sheets: [{ properties: { title: 'Submissions' } }, { properties: { title: 'Binds' } }] } });
  api.batchUpdate.mockResolvedValue({ data: {} });
});

describe('Google Sheets gateway', () => {
  it('appends RAW (no formula evaluation) and inserts rows instead of overwriting', async () => {
    await gateway().appendRows("Team's Log", 13, [['=IMPORTXML("http://x")', true]]);
    expect(api.values.append).toHaveBeenCalledWith({
      spreadsheetId: 'sheet-id',
      range: "'Team''s Log'!A:M",
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { majorDimension: 'ROWS', values: [['=IMPORTXML("http://x")', true]] },
    });
  });

  it('leaves retries to the writer', () => {
    gateway();
    expect(api.createClient).toHaveBeenCalledWith(expect.objectContaining({ version: 'v4', retry: false }));
  });

  it('updates whole rows in place, RAW', async () => {
    await gateway().updateRows('Binds', 6, [{ rowNumber: 7, cells: ['a', false] }]);
    expect(api.values.batchUpdate).toHaveBeenCalledWith({
      spreadsheetId: 'sheet-id',
      requestBody: { valueInputOption: 'RAW', data: [{ range: "'Binds'!A7:F7", values: [['a', false]] }] },
    });
  });

  it('pads ragged rows when reading', async () => {
    api.values.get.mockResolvedValue({ data: { values: [['a', 'b'], ['c']] } });
    await expect(gateway().readRows('Binds', 3)).resolves.toEqual([
      ['a', 'b', ''],
      ['c', '', ''],
    ]);
    expect(api.values.get).toHaveBeenCalledWith({ spreadsheetId: 'sheet-id', range: "'Binds'!A2:C" });
  });

  it('creates missing tabs and writes headers into empty ones', async () => {
    api.get.mockResolvedValue({ data: { sheets: [{ properties: { title: 'Submissions' } }] } });
    api.values.batchGet.mockResolvedValue({ data: { valueRanges: [{ values: [['a', 'b']] }, {}] } });
    await gateway().prepareTabs([
      { name: 'Submissions', headers: ['a', 'b'] },
      { name: 'Binds', headers: ['x', 'y', 'z'] },
    ]);
    expect(api.batchUpdate).toHaveBeenCalledWith({
      spreadsheetId: 'sheet-id',
      requestBody: { requests: [{ addSheet: { properties: { title: 'Binds' } } }] },
    });
    expect(api.values.batchUpdate).toHaveBeenCalledWith({
      spreadsheetId: 'sheet-id',
      requestBody: { valueInputOption: 'RAW', data: [{ range: "'Binds'!A1:C1", values: [['x', 'y', 'z']] }] },
    });
  });

  it('refuses a tab whose headers differ, but tolerates extra columns on the right', async () => {
    api.values.batchGet.mockResolvedValue({ data: { valueRanges: [{ values: [['a', 'b', 'notes']] }, { values: [['x', 'wrong']] }] } });
    const prepare = gateway().prepareTabs([
      { name: 'Submissions', headers: ['a', 'b'] },
      { name: 'Binds', headers: ['x', 'y'] },
    ]);
    await expect(prepare).rejects.toBeInstanceOf(HeaderMismatchError);
    await expect(prepare).rejects.toThrow(/"Binds" row 1 is \[x, wrong\], expected \[x, y\]/);
    expect(api.values.batchUpdate).not.toHaveBeenCalled();
  });

  it('re-checks headers with a single read', async () => {
    api.values.batchGet.mockResolvedValue({ data: { valueRanges: [{ values: [['a', 'b']] }, { values: [['x', 'y']] }] } });
    const tabs = [
      { name: 'Submissions', headers: ['a', 'b'] },
      { name: 'Binds', headers: ['x', 'y'] },
    ];
    await expect(gateway().checkHeaders(tabs)).resolves.toEqual([]);
    expect(api.values.batchGet).toHaveBeenCalledTimes(1);
    expect(api.get).not.toHaveBeenCalled();

    api.values.batchGet.mockResolvedValue({ data: { valueRanges: [{ values: [['a', 'notes', 'b']] }, { values: [['x', 'y']] }] } });
    await expect(gateway().checkHeaders(tabs)).rejects.toBeInstanceOf(HeaderMismatchError);

    api.values.batchGet.mockResolvedValue({ data: { valueRanges: [{}, { values: [['x', 'y']] }] } });
    await expect(gateway().checkHeaders(tabs)).rejects.toThrow(/row 1 of "Submissions" is empty/);
  });

  it('builds A1 references', () => {
    expect([0, 12, 25, 26, 27].map(columnLetter)).toEqual(['A', 'M', 'Z', 'AA', 'AB']);
    expect(quoteTab('Quest Log')).toBe("'Quest Log'");
  });
});

describe('Google Sheets gateway: older layouts', () => {
  const tabs = [
    { name: 'Submissions', headers: ['a', 'user', 'platform'], upgradeFrom: [['a', 'old_user']] },
    { name: 'Binds', headers: ['x', 'user', 'platform'], upgradeFrom: [['x', 'old_user']] },
  ];

  it('rewrites a recognised older layout (RAW) and reports which tabs it touched', async () => {
    api.values.batchGet.mockResolvedValue({ data: { valueRanges: [{ values: [['a', 'old_user']] }, { values: [['x', 'old_user']] }] } });
    await expect(gateway().prepareTabs(tabs)).resolves.toEqual(['Submissions', 'Binds']);
    expect(api.values.batchUpdate).toHaveBeenCalledWith({
      spreadsheetId: 'sheet-id',
      requestBody: {
        valueInputOption: 'RAW',
        data: [
          { range: "'Submissions'!A1:C1", values: [['a', 'user', 'platform']] },
          { range: "'Binds'!A1:C1", values: [['x', 'user', 'platform']] },
        ],
      },
    });
  });

  it('leaves tabs that are already current alone', async () => {
    api.values.batchGet.mockResolvedValue({ data: { valueRanges: [{ values: [['a', 'user', 'platform']] }, { values: [['x', 'user', 'platform', 'my notes']] }] } });
    await expect(gateway().prepareTabs(tabs)).resolves.toEqual([]);
    expect(api.values.batchUpdate).not.toHaveBeenCalled();
  });

  it('refuses an older layout when a reviewer column sits where the new column goes', async () => {
    api.values.batchGet.mockResolvedValue({ data: { valueRanges: [{ values: [['a', 'old_user', 'my notes']] }, { values: [['x', 'old_user']] }] } });
    await expect(gateway().prepareTabs(tabs)).rejects.toBeInstanceOf(HeaderMismatchError);
    expect(api.values.batchUpdate).not.toHaveBeenCalled();
  });

  it('refuses a layout it does not know, even one that looks close', async () => {
    api.values.batchGet.mockResolvedValue({ data: { valueRanges: [{ values: [['a', 'someone_else']] }, { values: [['x', 'old_user']] }] } });
    await expect(gateway().prepareTabs(tabs)).rejects.toThrow(/"Submissions" row 1 is \[a, someone_else\]/);
  });

  it('upgrades during the per-batch check too, but still treats an empty row 1 as an error', async () => {
    api.values.batchGet.mockResolvedValue({ data: { valueRanges: [{ values: [['a', 'old_user']] }, { values: [['x', 'user', 'platform']] }] } });
    await expect(gateway().checkHeaders(tabs)).resolves.toEqual(['Submissions']);

    api.values.batchGet.mockResolvedValue({ data: { valueRanges: [{}, { values: [['x', 'user', 'platform']] }] } });
    await expect(gateway().checkHeaders(tabs)).rejects.toThrow(/row 1 of "Submissions" is empty/);
  });
});
