import { beforeEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LotReceiptView } from './LotReceiptView';
import { clearApiCache } from '../lib/useApi';

/**
 * The screen for a process house that returns cloth in different pieces than
 * it was sent. Its job is to make the reconciliation visible before anything
 * is posted — how much went out, how much came back, and what that means as
 * shrinkage — and to refuse a lot that cannot be right.
 */
const OUTSTANDING = [{
  issue_id: 'i1', entry_no: 'DI-1', entry_date: '2026-08-22', challan_no: 'PC-77',
  lot_no: 'L-9', process_house: 'Prayag Texprint', process_house_id: 'ph1',
  thaans: 4, issued_qty: 1000, days_out: 14
}];

const posted: { path: string; body: any }[] = [];

function mockApi(over: Record<string, unknown> = {}) {
  clearApiCache();
  posted.length = 0;
  const routes: Record<string, unknown> = {
    '/dyeing-issues/outstanding': OUTSTANDING,
    '/ledgers': [{ id: 'ph1', name: 'Prayag Texprint', code: '202' }],
    ...over
  };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url).replace(/^.*\/api/, '').split('?')[0]!;
    if (init?.method === 'POST') {
      posted.push({ path, body: JSON.parse(String(init.body)) });
      return {
        ok: true, status: 201, headers: new Headers(),
        text: async () => JSON.stringify({
          entryNo: 'DR-9', thaansSent: 4, thaansReturned: 2,
          issuedQty: 1000, receivedQty: 970, shrinkagePct: 3
        })
      } as Response;
    }
    return { ok: true, status: 200, headers: new Headers(),
             text: async () => JSON.stringify(routes[path] ?? []) } as Response;
  }));
}

beforeEach(() => mockApi());

describe('LotReceiptView', () => {
  test('offers only what is actually still out at a process house', async () => {
    render(<LotReceiptView />);
    await waitFor(() => expect(
      screen.getByRole('option', { name: /PC-77 — Prayag Texprint — 4 thaan, 1000 mtr/ })
    ).toBeInTheDocument());
    expect(screen.getByText(/14 d out/)).toBeInTheDocument();
  });

  test('says plainly when to use the other screen instead', async () => {
    render(<LotReceiptView />);
    expect(screen.getByText(/If every barcode came back/)).toBeInTheDocument();
  });

  test('shows the reconciliation before anything is posted', async () => {
    render(<LotReceiptView />);
    fireEvent.change(await screen.findByLabelText(/Against challan/), { target: { value: 'i1' } });
    fireEvent.change(screen.getByLabelText('Barcode 1'), { target: { value: 'FIN-1' } });
    fireEvent.change(screen.getByLabelText('Metres 1'), { target: { value: '970' } });

    // 1,000 out, 970 back: 30 mtr gone, 3%.
    await waitFor(() => expect(screen.getByText(/30\.00 mtr · 3\.00%/)).toBeInTheDocument());
    expect(screen.getByText(/4 thaan · 1000 mtr/)).toBeInTheDocument();
    expect(screen.getByText(/1 thaan · 970\.00 mtr/)).toBeInTheDocument();
  });

  test('will not post without a challan, an issue and at least one thaan', async () => {
    render(<LotReceiptView />);
    const save = () => screen.getByRole('button', { name: /Post lot receipt/ });
    expect(save()).toBeDisabled();

    fireEvent.change(await screen.findByLabelText(/Against challan/), { target: { value: 'i1' } });
    expect(save()).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Their challan no/), { target: { value: 'PR-5' } });
    expect(save()).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Barcode 1'), { target: { value: 'FIN-1' } });
    fireEvent.change(screen.getByLabelText('Metres 1'), { target: { value: '970' } });
    expect(save()).toBeEnabled();
  });

  test('two thaans given the same barcode is caught before it reaches the server', async () => {
    render(<LotReceiptView />);
    fireEvent.change(await screen.findByLabelText(/Against challan/), { target: { value: 'i1' } });
    fireEvent.change(screen.getByLabelText(/Their challan no/), { target: { value: 'PR-5' } });
    fireEvent.change(screen.getByLabelText('Barcode 1'), { target: { value: 'FIN-1' } });
    fireEvent.change(screen.getByLabelText('Metres 1'), { target: { value: '500' } });

    fireEvent.click(screen.getByRole('button', { name: /Add thaan/ }));
    fireEvent.change(screen.getByLabelText('Barcode 2'), { target: { value: 'FIN-1' } });
    fireEvent.change(screen.getByLabelText('Metres 2'), { target: { value: '470' } });

    expect(await screen.findByText(/same barcode/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Post lot receipt/ })).toBeDisabled();
    expect(posted).toHaveLength(0);
  });

  test('posts the issue and the new thaans, then reports what it did', async () => {
    render(<LotReceiptView />);
    fireEvent.change(await screen.findByLabelText(/Against challan/), { target: { value: 'i1' } });
    fireEvent.change(screen.getByLabelText(/Their challan no/), { target: { value: 'PR-5' } });
    fireEvent.change(screen.getByLabelText('Barcode 1'), { target: { value: 'FIN-1' } });
    fireEvent.change(screen.getByLabelText('Metres 1'), { target: { value: '600' } });
    fireEvent.click(screen.getByRole('button', { name: /Add thaan/ }));
    fireEvent.change(screen.getByLabelText('Barcode 2'), { target: { value: 'FIN-2' } });
    fireEvent.change(screen.getByLabelText('Metres 2'), { target: { value: '370' } });

    fireEvent.click(screen.getByRole('button', { name: /Post lot receipt/ }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]!.path).toBe('/dyeing-receipts/by-lot');
    expect(posted[0]!.body).toMatchObject({
      issueId: 'i1', challanNo: 'PR-5',
      pieces: [
        { barcode: 'FIN-1', qty: 600, finishGrade: 'A' },
        { barcode: 'FIN-2', qty: 370, finishGrade: 'A' }
      ]
    });
    expect(await screen.findByText(/DR-9: 4 thaan sent, 2 back/)).toBeInTheDocument();
  });

  test('a refusal from the server is shown, not swallowed', async () => {
    render(<LotReceiptView />);
    fireEvent.change(await screen.findByLabelText(/Against challan/), { target: { value: 'i1' } });
    fireEvent.change(screen.getByLabelText(/Their challan no/), { target: { value: 'PR-5' } });
    fireEvent.change(screen.getByLabelText('Barcode 1'), { target: { value: 'FIN-1' } });
    fireEvent.change(screen.getByLabelText('Metres 1'), { target: { value: '400' } });

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 400, headers: new Headers(), statusText: 'Bad Request',
      text: async () => JSON.stringify({ error: 'the lot lost 60.00% against a 12% limit' })
    } as Response)));

    fireEvent.click(screen.getByRole('button', { name: /Post lot receipt/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/lost 60.00%/);
  });
});
