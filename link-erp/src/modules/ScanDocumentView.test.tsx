import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { ScanDocumentView } from './ScanDocumentView';

/**
 * The screen a storekeeper spends the day on, and — until now — the only floor
 * screen with no tests at all.
 *
 * Two things matter here and neither is layout. A barcode that is not eligible
 * for this document must be refused at the scanner, before the operator has
 * walked anywhere; and the same thaan must never appear twice on one challan.
 * Both are cheaper to catch here than in the server's error banner.
 */

const PIECE = (barcode: string) => ({
  id: `id-${barcode}`, barcode, status: 'grey_in_stock', lot_no: '1100/B',
  grade_code: 'LUMP', uom: 'MTR', rack_code: 'A1', grey_qty: 100, finish_qty: null,
  current_qty: 100, cost: 3000, quality: 'Galaxy', design: null, held_by: null
});

const routes: Record<string, unknown> = {};

function mockApi(over: Record<string, unknown> = {}) {
  Object.keys(routes).forEach(k => delete routes[k]);
  Object.assign(routes, {
    '/ledgers': [{ id: 'l1', name: 'Prayag Texprint Llp', control_account_id: 'c1' }],
    '/control-accounts': [{ id: 'c1', nature: 'sundry_creditor_process' }],
    '/pieces': [PIECE('NKT001'), PIECE('NKT002')],
    '/sales-orders': { rows: [] },
    '/sales-invoices': { rows: [] },
    ...over
  });

  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const bare = String(url).replace(/^.*\/api/, '').split('?')[0]!;
    return {
      ok: true, status: 200, headers: new Headers(),
      text: async () => JSON.stringify(routes[bare] ?? [])
    } as unknown as Response;
  }));
}

const scanBox = () => screen.getByLabelText(/Scan barcode/i);

beforeEach(() => mockApi());

describe('scanning pieces onto a challan', () => {
  test('a scanned piece is added to the challan', async () => {
    render(<ScanDocumentView kind="issue" />);
    await waitFor(() => expect(screen.getByText(/2 pieces eligible/)).toBeInTheDocument());

    fireEvent.change(scanBox(), { target: { value: 'NKT001' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(screen.getByText('NKT001')).toBeInTheDocument());
    expect(screen.getByText(/Pieces: 1/)).toBeInTheDocument();
  });

  test('the Add button works as well as the Enter key, for a gloved thumb', async () => {
    render(<ScanDocumentView kind="issue" />);
    await waitFor(() => expect(screen.getByText(/2 pieces eligible/)).toBeInTheDocument());

    fireEvent.change(scanBox(), { target: { value: 'NKT001' } });
    fireEvent.submit(scanBox().closest('form')!);
    await waitFor(() => expect(screen.getByText(/Pieces: 1/)).toBeInTheDocument());

    fireEvent.change(scanBox(), { target: { value: 'NKT002' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(screen.getByText(/Pieces: 2/)).toBeInTheDocument());
  });

  test('the same thaan cannot be put on one challan twice', async () => {
    render(<ScanDocumentView kind="issue" />);
    await waitFor(() => expect(screen.getByText(/2 pieces eligible/)).toBeInTheDocument());

    for (let i = 0; i < 2; i++) {
      fireEvent.change(scanBox(), { target: { value: 'NKT001' } });
      fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    }

    await waitFor(() =>
      expect(screen.getByText(/NKT001 is already on this challan/)).toBeInTheDocument());
    expect(screen.getByText(/Pieces: 1/)).toBeInTheDocument();
  });

  test('a barcode not eligible for this document is refused at the scanner', async () => {
    render(<ScanDocumentView kind="issue" />);
    await waitFor(() => expect(screen.getByText(/2 pieces eligible/)).toBeInTheDocument());

    fireEvent.change(scanBox(), { target: { value: 'GHOST9' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() =>
      expect(screen.getByText(/GHOST9 is not available for this document/)).toBeInTheDocument());
    expect(screen.getByText(/Pieces: 0/)).toBeInTheDocument();
  });

  test('an empty scan does nothing rather than adding a blank line', async () => {
    render(<ScanDocumentView kind="issue" />);
    await waitFor(() => expect(screen.getByText(/2 pieces eligible/)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByText(/Pieces: 0/)).toBeInTheDocument();
  });

  test('two hundred thaans are picked from a list, not scanned one at a time', async () => {
    render(<ScanDocumentView kind="issue" />);
    await waitFor(() => expect(screen.getByText(/2 pieces eligible/)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Pick from stock/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Add all 2/ }));
    await waitFor(() => expect(screen.getByText(/Pieces: 2/)).toBeInTheDocument());
  });

  test('the picker filters by quality, lot, rack or barcode', async () => {
    render(<ScanDocumentView kind="issue" />);
    await waitFor(() => expect(screen.getByText(/2 pieces eligible/)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Pick from stock/ }));
    fireEvent.change(await screen.findByLabelText('Filter stock'), { target: { value: 'NKT002' } });
    expect(screen.getByRole('button', { name: /Add all 1/ })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Filter stock'), { target: { value: 'nothing' } });
    expect(screen.getByText(/Nothing eligible matches that/)).toBeInTheDocument();
  });

  test('picking one twice takes it off rather than adding it twice', async () => {
    render(<ScanDocumentView kind="issue" />);
    await waitFor(() => expect(screen.getByText(/2 pieces eligible/)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Pick from stock/ }));
    const box = await screen.findByRole('checkbox', { name: /Pick NKT001/ });
    fireEvent.click(box);
    await waitFor(() => expect(screen.getByText(/Pieces: 1/)).toBeInTheDocument());
    fireEvent.click(box);
    await waitFor(() => expect(screen.getByText(/Pieces: 0/)).toBeInTheDocument());
  });

  test('a thaan\'s journey opens beside the challan', async () => {
    mockApi({
      '/pieces/NKT001/flow': [{
        event: 'inward', from_status: null, to_status: 'grey_in_stock',
        qty_before: 0, qty_after: 100, counterparty: 'L.R. Textiles',
        doc_type: 'grey_inward', occurred_at: '2026-08-21T06:00:00Z'
      }]
    });
    render(<ScanDocumentView kind="issue" />);
    await waitFor(() => expect(screen.getByText(/2 pieces eligible/)).toBeInTheDocument());

    fireEvent.change(scanBox(), { target: { value: 'NKT001' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(screen.getByText(/Pieces: 1/)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Journey of NKT001/ }));
    await waitFor(() => expect(screen.getByText(/Journey of/)).toBeInTheDocument());
    expect(await screen.findByText('L.R. Textiles')).toBeInTheDocument();
    expect(screen.getByText('inward')).toBeInTheDocument();
  });

  test('a dispatch records which bale each thaan went into', async () => {
    mockApi({
      '/pieces': [{ ...PIECE('NKT001'), status: 'cut_packed' }],
      '/control-accounts': [{ id: 'c1', nature: 'sundry_debtor_finish' }]
    });
    render(<ScanDocumentView kind="dispatch" />);
    await waitFor(() => expect(screen.getByText(/1 pieces eligible/)).toBeInTheDocument());

    fireEvent.change(scanBox(), { target: { value: 'NKT001' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    const bale = await screen.findByLabelText('Bale number for NKT001');
    fireEvent.change(bale, { target: { value: '3' } });
    expect(bale).toHaveValue(3);
  });

  test('a scanned piece can be taken off again', async () => {
    render(<ScanDocumentView kind="issue" />);
    await waitFor(() => expect(screen.getByText(/2 pieces eligible/)).toBeInTheDocument());

    fireEvent.change(scanBox(), { target: { value: 'NKT001' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(screen.getByText(/Pieces: 1/)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Remove NKT001/ }));
    await waitFor(() => expect(screen.getByText(/Pieces: 0/)).toBeInTheDocument());
  });
});
