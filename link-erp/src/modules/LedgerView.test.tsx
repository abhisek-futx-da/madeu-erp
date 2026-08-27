import { beforeEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LedgerView } from './LedgerView';
import { clearApiCache } from '../lib/useApi';

/**
 * A ledger is only useful if it opens with the balance carried forward and
 * closes on the arithmetic. The screen's job is to show both, to read Dr/Cr
 * the way an Indian ledger is read, and never to ask the server for a period
 * that runs backwards.
 */
const STATEMENT = {
  ledger: { code: '105', name: 'L.R. Textiles' },
  from: '2026-04-01', to: '2026-09-30',
  opening: -30500, closing: -32500,
  totals: { debit: 500, credit: 2500 },
  rows: [
    { seq: 0, voucher_date: '2026-04-01', voucher_type: 'opening', voucher_no: '',
      narration: 'Opening balance', debit: 0, credit: 30500, running_balance: -30500 },
    { seq: 1, voucher_date: '2026-09-15', voucher_type: 'purchase', voucher_no: 'PUR-1',
      narration: 'Grey inward', debit: 0, credit: 2500, running_balance: -33000 },
    { seq: 2, voucher_date: '2026-09-20', voucher_type: 'payment', voucher_no: 'PAY-1',
      narration: 'Part payment', debit: 500, credit: 0, running_balance: -32500 }
  ]
};

const asked: string[] = [];

function mockApi(statement: unknown = STATEMENT) {
  clearApiCache();
  asked.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const full = String(url).replace(/^.*\/api/, '');
    asked.push(full);
    const body = full.startsWith('/ledgers')
      ? [{ id: 'l1', code: '105', name: 'L.R. Textiles' },
         { id: 'l2', code: '629', name: 'Kanhaiya Textiles' }]
      : statement;
    return { ok: true, status: 200, headers: new Headers(),
             text: async () => JSON.stringify(body) } as Response;
  }));
}

describe('LedgerView', () => {
  beforeEach(() => mockApi());

  test('nothing is fetched until an account is chosen', async () => {
    render(<LedgerView />);
    await screen.findByText(/Choose an account to see its ledger/);
    expect(asked.some(u => u.startsWith('/ledger?'))).toBe(false);
  });

  test('choosing an account asks the server for that account and period', async () => {
    render(<LedgerView />);
    fireEvent.change(await screen.findByLabelText('Account'), { target: { value: 'l1' } });

    await waitFor(() => expect(asked.some(u =>
      u.startsWith('/ledger?ledgerId=l1') && u.includes('from=') && u.includes('to='))).toBe(true));
  });

  test('the opening balance is carried forward and the closing follows the arithmetic', async () => {
    render(<LedgerView />);
    fireEvent.change(await screen.findByLabelText('Account'), { target: { value: 'l1' } });

    await screen.findByText('Grey inward');
    // -30,500 opening + 500 debits - 2,500 credits = -32,500 closing, shown as Cr.
    expect(screen.getAllByText('30,500.00 Cr').length).toBeGreaterThan(0);
    expect(screen.getAllByText('32,500.00 Cr').length).toBeGreaterThan(0);
    expect(screen.getByText('Opening balance')).toBeInTheDocument();
  });

  test('a period that runs backwards is refused before it reaches the server', async () => {
    render(<LedgerView />);
    fireEvent.change(await screen.findByLabelText('Account'), { target: { value: 'l1' } });
    await screen.findByText('Grey inward');

    asked.length = 0;
    fireEvent.change(screen.getByLabelText('From date'), { target: { value: '2027-01-01' } });
    fireEvent.change(screen.getByLabelText('To date'), { target: { value: '2026-01-01' } });

    expect(await screen.findByRole('alert')).toHaveTextContent(/closing date falls before/i);
    expect(asked.some(u => u.includes('from=2027-01-01'))).toBe(false);
  });

  test('an account with no postings in the window says so rather than showing nothing', async () => {
    mockApi({ ...STATEMENT, rows: [], totals: { debit: 0, credit: 0 } });
    render(<LedgerView />);
    fireEvent.change(await screen.findByLabelText('Account'), { target: { value: 'l2' } });

    await screen.findByText(/Nothing was posted to this account in that period/);
  });
});
