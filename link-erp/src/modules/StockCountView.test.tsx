import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { StockCountView } from './StockCountView';

/**
 * The screen's job is to make an unexplained stock correction impossible. Its
 * tests are therefore mostly about what it refuses: an outcome that does not
 * fit the difference, an answer with no reason, and any suggestion that an
 * unknown barcode can be conjured into stock from here.
 */

const COUNT = {
  count_id: 'c1', count_no: 'SC/26-27/1', count_date: '2026-08-27', status: 'draft',
  rack_code: 'A1', quality: 'Galaxy', lot_no: '1100/B', reason: 'month end',
  pieces_expected: 3, pieces_counted: 2, variances: 0,
  loss_value: 0, gain_value: 0, net_value: 0, counted_by: 'Store Keeper'
};

const SHEET = [
  { barcode: 'NKT001', quality: 'Galaxy', rack_code: 'A1', qty: 100, status: 'grey_in_stock', lot_no: '1100/B', scanned: true },
  { barcode: 'NKT002', quality: 'Galaxy', rack_code: 'A1', qty: 100, status: 'grey_in_stock', lot_no: '1100/B', scanned: false },
  { barcode: 'NKT003', quality: 'Galaxy', rack_code: 'A1', qty: 100, status: 'grey_in_stock', lot_no: '1100/B', scanned: true }
];

const EXCEPTIONS = [
  { barcode: 'NKT002', piece_id: 'p2', kind: 'missing', system_qty: 100, counted_qty: 0,
    system_rack: 'A1', counted_rack: null, value: -3000 },
  { barcode: 'NKT003', piece_id: 'p3', kind: 'short', system_qty: 100, counted_qty: 98,
    system_rack: 'A1', counted_rack: 'A1', value: -60 },
  { barcode: 'GHOST9', piece_id: null, kind: 'extra', system_qty: null, counted_qty: 55,
    system_rack: null, counted_rack: 'A1', value: 0 }
];

const posted: { path: string; method: string; body: unknown }[] = [];

function mockApi(routes: Record<string, unknown>) {
  posted.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url).replace(/^.*\/api/, '');
    const bare = path.split('?')[0]!;
    const method = init?.method ?? 'GET';
    if (method !== 'GET') {
      posted.push({ path: bare, method, body: init?.body ? JSON.parse(String(init.body)) : null });
    }
    const body = routes[`${method} ${bare}`] ?? routes[bare] ?? [];
    return {
      ok: true, status: 200, headers: new Headers(),
      text: async () => JSON.stringify(body)
    } as unknown as Response;
  }));
}

const detail = (over: Partial<Record<string, unknown>> = {}) => ({
  count: COUNT, sheet: SHEET, exceptions: EXCEPTIONS, scans: [], variances: [], ...over
});

const openSheet = async () => {
  await waitFor(() => expect(screen.getByText('SC/26-27/1')).toBeInTheDocument());
  fireEvent.click(screen.getByText('SC/26-27/1'));
  await waitFor(() => expect(screen.getByLabelText(/Scan the thaan/i)).toBeInTheDocument());
};

beforeEach(() => {
  mockApi({
    '/stock-counts': { rows: [COUNT], total: 1 },
    '/stock-counts/c1': detail(),
    '/racks': [{ code: 'A1', name: 'Rack A1' }],
    '/qualities': [{ id: 'q1', name: 'Galaxy' }]
  });
});

describe('opening a count', () => {
  test('lists what has been counted, and what it cost', async () => {
    render(<StockCountView />);
    await waitFor(() => expect(screen.getByText('SC/26-27/1')).toBeInTheDocument());
    expect(screen.getByText('Rack A1 · Galaxy · Lot 1100/B')).toBeInTheDocument();
    expect(screen.getByText('Counting')).toBeInTheDocument();
  });

  test('the scope defaults to everything, and says so', async () => {
    render(<StockCountView />);
    await waitFor(() => expect(screen.getByText('Open a new count')).toBeInTheDocument());
    expect(screen.getByText(/every rack/)).toBeInTheDocument();
    expect(screen.getByText(/Goods lying at a process house are not counted here/)).toBeInTheDocument();
  });

  test('opening one posts the chosen scope', async () => {
    mockApi({
      '/stock-counts': { rows: [], total: 0 },
      'POST /stock-counts': { id: 'c1', countNo: 'SC/26-27/2', piecesExpected: 3 },
      '/stock-counts/c1': detail(),
      '/racks': [{ code: 'A1', name: 'Rack A1' }],
      '/qualities': [{ id: 'q1', name: 'Galaxy' }]
    });
    render(<StockCountView />);
    await waitFor(() => expect(screen.getByText('Open a new count')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('Rack'), { target: { value: 'A1' } });
    fireEvent.click(screen.getByRole('button', { name: /Save/ }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]!.path).toBe('/stock-counts');
    expect((posted[0]!.body as any).rackCode).toBe('A1');
  });
});

describe('answering the differences', () => {
  test('every difference is shown with what the books and the floor say', async () => {
    render(<StockCountView />);
    await openSheet();

    expect(screen.getByText(/3 difference\(s\)/)).toBeInTheDocument();
    expect(screen.getByText('Not on the rack')).toBeInTheDocument();
    expect(screen.getByText('Shorter than the books')).toBeInTheDocument();
    expect(screen.getByText('Found, not expected')).toBeInTheDocument();
    expect(screen.getByText('−₹3,000.00')).toBeInTheDocument();
  });

  test('an unknown barcode may only be booked in separately', async () => {
    render(<StockCountView />);
    await openSheet();

    const selects = screen.getAllByRole('combobox');
    // Three exception rows, in the order the fixture lists them.
    const ghost = selects[2]!;
    const options = [...ghost.querySelectorAll('option')].map(o => o.textContent);
    expect(options).toContain('Book it in separately');
    expect(options).not.toContain('Record the new shelf');
    expect(options).not.toContain('Write it off');
  });

  test('a missing piece cannot be answered by moving it', async () => {
    render(<StockCountView />);
    await openSheet();

    const missing = screen.getAllByRole('combobox')[0]!;
    const options = [...missing.querySelectorAll('option')].map(o => o.textContent);
    expect(options).toContain('Write it off');
    expect(options).not.toContain('Record the new shelf');
  });

  test('nothing can be submitted until every difference has an answer and a reason', async () => {
    render(<StockCountView />);
    await openSheet();

    const save = screen.getByRole('button', { name: /Save/ });
    expect(save).toBeDisabled();

    const selects = screen.getAllByRole('combobox');
    const reasons = screen.getAllByPlaceholderText('required');
    fireEvent.change(selects[0]!, { target: { value: 'write_off' } });
    fireEvent.change(reasons[0]!, { target: { value: 'not in the godown' } });
    expect(screen.getByRole('button', { name: /Save/ })).toBeDisabled();

    fireEvent.change(selects[1]!, { target: { value: 'adjust_qty' } });
    fireEvent.change(screen.getAllByPlaceholderText('required')[1]!, { target: { value: 'tape says 98' } });
    fireEvent.change(selects[2]!, { target: { value: 'needs_inward' } });
    fireEvent.change(screen.getAllByPlaceholderText('required')[2]!, { target: { value: 'no challan' } });

    await waitFor(() => expect(screen.getByRole('button', { name: /Save/ })).toBeEnabled());
  });

  test('an answer with a blank reason does not count as answered', async () => {
    render(<StockCountView />);
    await openSheet();

    const selects = screen.getAllByRole('combobox');
    selects.forEach(s => fireEvent.change(s, { target: { value: 'investigate' } }));
    expect(screen.getByRole('button', { name: /Save/ })).toBeDisabled();
  });

  test('submitting sends the outcome and reason for every difference', async () => {
    render(<StockCountView />);
    await openSheet();

    const selects = screen.getAllByRole('combobox');
    fireEvent.change(selects[0]!, { target: { value: 'write_off' } });
    fireEvent.change(selects[1]!, { target: { value: 'adjust_qty' } });
    fireEvent.change(selects[2]!, { target: { value: 'needs_inward' } });
    screen.getAllByPlaceholderText('required').forEach((r, i) =>
      fireEvent.change(r, { target: { value: `reason ${i}` } }));

    fireEvent.click(screen.getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(posted.some(p => p.path === '/stock-counts/c1/submit')).toBe(true));

    const sent = posted.find(p => p.path === '/stock-counts/c1/submit')!.body as any;
    expect(sent.decisions).toHaveLength(3);
    expect(sent.decisions[0]).toEqual({
      barcode: 'NKT002', kind: 'missing', outcome: 'write_off', reason: 'reason 0'
    });
  });
});

describe('a count waiting on approval', () => {
  const HELD = detail({
    count: { ...COUNT, status: 'pending_approval', variances: 1, net_value: -3000 },
    exceptions: [],
    variances: [{
      barcode: 'NKT002', kind: 'missing', outcome: 'write_off', system_qty: 100,
      counted_qty: 0, system_rack: 'A1', counted_rack: null, value: -3000,
      reason: 'not in the godown', quality: 'Galaxy'
    }]
  });

  test('says plainly that nothing has moved yet', async () => {
    mockApi({
      '/stock-counts': { rows: [{ ...COUNT, status: 'pending_approval' }], total: 1 },
      '/stock-counts/c1': HELD,
      '/racks': [], '/qualities': []
    });
    render(<StockCountView />);
    await waitFor(() => expect(screen.getByText('SC/26-27/1')).toBeInTheDocument());
    fireEvent.click(screen.getByText('SC/26-27/1'));

    await waitFor(() =>
      expect(screen.getByText(/Nothing has moved yet/)).toBeInTheDocument());
    expect(screen.getByText(/Variance report/)).toBeInTheDocument();
    expect(screen.getByText('not in the godown')).toBeInTheDocument();
    // No scanner and no Save: the sheet is closed.
    expect(screen.queryByLabelText(/Scan the thaan/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /Save/ })).toBeNull();
  });

  test('a reversed count shows its variances struck through', async () => {
    mockApi({
      '/stock-counts': { rows: [{ ...COUNT, status: 'cancelled' }], total: 1 },
      '/stock-counts/c1': detail({
        count: { ...COUNT, status: 'cancelled', variances: 1, net_value: -3000 },
        exceptions: [],
        variances: HELD.variances
      }),
      '/racks': [], '/qualities': []
    });
    render(<StockCountView />);
    await waitFor(() => expect(screen.getByText('SC/26-27/1')).toBeInTheDocument());
    fireEvent.click(screen.getByText('SC/26-27/1'));

    await waitFor(() =>
      expect(screen.getByText(/this count was reversed/)).toBeInTheDocument());
    expect(screen.getAllByText('Reversed').length).toBeGreaterThan(0);
  });
});
