import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { PieceRegroupView } from './PieceRegroupView';

/**
 * The risk on this screen is arithmetic, not layout. An operator who keys
 * 40 + 40 against a 118 metre thaan must be stopped before saving, because
 * after saving the stock ledger is wrong and nothing in the building knows it.
 */

const GREY = {
  id: 'p1', barcode: 'NKT001', status: 'grey_in_stock', lot_no: '1100/B',
  grade_code: 'LUMP', uom: 'MTR', grey_qty: 118, finish_qty: null, current_qty: 118,
  cost: 3599, quality: 'Galaxy', design: null, held_by: null
};

const posted: { path: string; body: unknown }[] = [];

function mockApi(routes: Record<string, unknown>) {
  posted.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url).replace(/^.*\/api/, '');
    const bare = path.split('?')[0]!;
    if ((init?.method ?? 'GET') !== 'GET') {
      posted.push({ path: bare, body: JSON.parse(String(init?.body ?? 'null')) });
    }
    const key = `${init?.method ?? 'GET'} ${bare}`;
    const body = routes[key] ?? routes[bare] ?? [];
    return {
      ok: true, status: 200, headers: new Headers(),
      text: async () => JSON.stringify(body)
    } as unknown as Response;
  }));
}

const find = async (barcode = 'NKT001') => {
  fireEvent.change(screen.getByLabelText(/Scan the thaan to cut/i), { target: { value: barcode } });
  fireEvent.click(screen.getByRole('button', { name: /^Find$/ }));
};

const lengths = () => screen.getAllByRole('spinbutton');

beforeEach(() => {
  mockApi({ '/pieces': [GREY], '/pieces/NKT001/lineage': [] });
});

describe('cutting a thaan', () => {
  test('shows what the scanned thaan holds and what it is worth', async () => {
    render(<PieceRegroupView />);
    await find();
    await waitFor(() => expect(screen.getByText('NKT001')).toBeInTheDocument());
    expect(screen.getByText('Galaxy')).toBeInTheDocument();
    expect(screen.getByText('118.00 MTR')).toBeInTheDocument();
    expect(screen.getByText('₹3,599.00')).toBeInTheDocument();
  });

  test('the remainder is on screen the whole time', async () => {
    render(<PieceRegroupView />);
    await find();
    await waitFor(() => expect(screen.getByText('NKT001')).toBeInTheDocument());

    fireEvent.change(lengths()[0]!, { target: { value: '40' } });
    fireEvent.change(lengths()[1]!, { target: { value: '40' } });
    expect(screen.getByText('38.00 left')).toBeInTheDocument();
    expect(screen.getByText(/38.00 MTR is unaccounted for/)).toBeInTheDocument();
  });

  test('a cut that does not add up cannot be saved', async () => {
    render(<PieceRegroupView />);
    await find();
    await waitFor(() => expect(screen.getByText('NKT001')).toBeInTheDocument());

    fireEvent.change(lengths()[0]!, { target: { value: '40' } });
    fireEvent.change(lengths()[1]!, { target: { value: '40' } });
    expect(screen.getByRole('button', { name: /Save/ })).toBeDisabled();

    fireEvent.click(screen.getAllByRole('button', { name: /\+ rest/ })[1]!);
    expect(screen.getByText('adds up')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Save/ })).toBeEnabled();
  });

  test('pieces longer than the thaan are called out, not silently accepted', async () => {
    render(<PieceRegroupView />);
    await find();
    await waitFor(() => expect(screen.getByText('NKT001')).toBeInTheDocument());

    fireEvent.change(lengths()[0]!, { target: { value: '100' } });
    fireEvent.change(lengths()[1]!, { target: { value: '50' } });
    expect(screen.getByText(/longer than the thaan/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Save/ })).toBeDisabled();
  });

  test('a saved cut posts exactly the lengths on screen', async () => {
    mockApi({
      '/pieces': [GREY],
      '/pieces/NKT001/lineage': [],
      'POST /pieces/NKT001/split': {
        entryNo: 'RG-1', from: 'NKT001', qty: 118,
        pieces: [{ barcode: 'NKT001-1', qty: 70, cost: 2135.59 },
                 { barcode: 'NKT001-2', qty: 48, cost: 1463.41 }]
      }
    });
    render(<PieceRegroupView />);
    await find();
    await waitFor(() => expect(screen.getByText('NKT001')).toBeInTheDocument());

    fireEvent.change(lengths()[0]!, { target: { value: '70' } });
    fireEvent.change(lengths()[1]!, { target: { value: '48' } });
    fireEvent.click(screen.getByRole('button', { name: /Save/ }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]!.path).toBe('/pieces/NKT001/split');
    expect((posted[0]!.body as any).children).toEqual([{ qty: 70 }, { qty: 48 }]);
  });

  test('goods at a process house are refused before anything is typed', async () => {
    mockApi({ '/pieces': [{ ...GREY, status: 'issued_to_dyeing' }] });
    render(<PieceRegroupView />);
    await find();
    await waitFor(() =>
      expect(screen.getByText(/only goods in our own custody can be cut/)).toBeInTheDocument());
    expect(screen.queryByRole('spinbutton')).toBeNull();
  });

  test('an unknown barcode says so instead of showing an empty form', async () => {
    mockApi({ '/pieces': [] });
    render(<PieceRegroupView />);
    await find('GHOST');
    await waitFor(() =>
      expect(screen.getByText('No piece carries the barcode GHOST')).toBeInTheDocument());
  });
});

describe('undoing a cut', () => {
  const HISTORY = [
    { regroup_id: 'rg-1', entry_no: 'RG-7', entry_date: '2026-08-22', kind: 'split',
      reason: 'fat fingers', from_barcode: 'NKT001', to_barcode: 'NKT001-1',
      qty: 30, cost: 915, doc_status: 'approved', to_status: 'consumed' },
    { regroup_id: 'rg-1', entry_no: 'RG-7', entry_date: '2026-08-22', kind: 'split',
      reason: 'fat fingers', from_barcode: 'NKT001', to_barcode: 'NKT001-2',
      qty: 88, cost: 2684, doc_status: 'approved', to_status: 'consumed' }
  ];

  const session = (role: string) => ({
    userId: 'u1', tenantId: 't1', role, tenant: null, user: null
  }) as any;

  test('offered once per entry to someone who may reverse it', async () => {
    mockApi({ '/pieces': [GREY], '/pieces/NKT001/lineage': HISTORY });
    render(<PieceRegroupView session={session('accounts')} />);
    await find();
    await waitFor(() => expect(screen.getAllByText('RG-7').length).toBe(2));
    // Two lineage rows, one entry, one Undo.
    expect(screen.getAllByRole('button', { name: /Undo/ })).toHaveLength(1);
  });

  test('not offered to a store clerk, who the server would refuse anyway', async () => {
    mockApi({ '/pieces': [GREY], '/pieces/NKT001/lineage': HISTORY });
    render(<PieceRegroupView session={session('store')} />);
    await find();
    await waitFor(() => expect(screen.getAllByText('RG-7').length).toBe(2));
    expect(screen.queryByRole('button', { name: /Undo/ })).toBeNull();
  });

  test('an already-cancelled entry cannot be reversed twice', async () => {
    mockApi({
      '/pieces': [GREY],
      '/pieces/NKT001/lineage': HISTORY.map(r => ({ ...r, doc_status: 'cancelled' }))
    });
    render(<PieceRegroupView session={session('owner')} />);
    await find();
    await waitFor(() => expect(screen.getAllByText('RG-7').length).toBe(2));
    expect(screen.queryByRole('button', { name: /Undo/ })).toBeNull();
  });

  test('a reversal needs a reason and posts a cancellation', async () => {
    mockApi({
      '/pieces': [GREY], '/pieces/NKT001/lineage': HISTORY,
      'POST /documents/piece_regroup/rg-1/cancel': { cancelled: true }
    });
    vi.stubGlobal('prompt', vi.fn(() => 'wrong lengths keyed'));
    render(<PieceRegroupView session={session('owner')} />);
    await find();
    await waitFor(() => expect(screen.getAllByText('RG-7').length).toBe(2));

    fireEvent.click(screen.getByRole('button', { name: /Undo/ }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]!.path).toBe('/documents/piece_regroup/rg-1/cancel');
    expect(posted[0]!.body).toEqual({ reason: 'wrong lengths keyed' });
  });

  test('a reversal with no reason given is abandoned, not sent', async () => {
    mockApi({ '/pieces': [GREY], '/pieces/NKT001/lineage': HISTORY });
    vi.stubGlobal('prompt', vi.fn(() => null));
    render(<PieceRegroupView session={session('owner')} />);
    await find();
    await waitFor(() => expect(screen.getAllByText('RG-7').length).toBe(2));

    fireEvent.click(screen.getByRole('button', { name: /Undo/ }));
    expect(posted).toHaveLength(0);
  });
});

describe('joining short ends', () => {
  const openMerge = () => fireEvent.click(screen.getByRole('button', { name: /Join Short Ends/ }));

  test('a mismatched piece is rejected at the scanner, not after the walk back', async () => {
    mockApi({ '/pieces': [GREY] });
    render(<PieceRegroupView />);
    openMerge();

    const scan = screen.getByLabelText(/Scan each short end/i);
    fireEvent.change(scan, { target: { value: 'NKT001' } });
    fireEvent.submit(scan);
    await waitFor(() => expect(screen.getByText('NKT001')).toBeInTheDocument());

    mockApi({ '/pieces': [{ ...GREY, id: 'p2', barcode: 'NKT002', quality: 'Diamond' }] });
    fireEvent.change(scan, { target: { value: 'NKT002' } });
    fireEvent.submit(scan);
    await waitFor(() => expect(screen.getByText(/will not join Galaxy/)).toBeInTheDocument());
  });

  test('a merge needs two pieces and a fresh barcode before it can be saved', async () => {
    mockApi({ '/pieces': [GREY] });
    render(<PieceRegroupView />);
    openMerge();
    expect(screen.getByRole('button', { name: /Save/ })).toBeDisabled();
    expect(screen.getByText(/Scan two or more pieces/)).toBeInTheDocument();
  });
});
