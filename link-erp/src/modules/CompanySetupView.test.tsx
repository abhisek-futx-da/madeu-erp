import { beforeEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CompanySetupView } from './CompanySetupView';

const calls: Array<{ path: string; body: any }> = [];

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url).replace(/^.*\/api/, '').split('?')[0]!;
    if (init?.method === 'POST') {
      calls.push({ path, body: JSON.parse(String(init.body ?? '{}')) });
      return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify({ saved: true }) } as Response;
    }
    const body: Record<string, unknown> = {
      '/financial-years': [{ label: '2026-27', status: 'open' }],
      '/ledgers': [{ id: '00000000-0000-0000-0000-000000000001', code: '970', name: 'Cash' }],
      '/qualities': [],
      '/approval-rules': [],
      '/configuration': { settings: [], shrinkage: [], brokerage: [], rates: [], tdsSections: [], series: [], ledgerTds: [], audit: [] },
      '/opening-balances/2026-27': [
        { ledger_id: '00000000-0000-0000-0000-000000000001', code: '970', name: 'Cash', control_account: 'Cash', nature: 'cash', debit: 100, credit: 0 },
        { ledger_id: '00000000-0000-0000-0000-000000000002', code: '950', name: 'Capital', control_account: 'Capital', nature: 'capital', debit: 0, credit: 100 }
      ]
    };
    return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify(body[path] ?? []) } as Response;
  }));
});

describe('CompanySetupView', () => {
  test('opening controls have accessible names and refuse an unbalanced save', async () => {
    render(<CompanySetupView />);
    const debit = await screen.findByLabelText('Debit opening for Cash');
    const credit = screen.getByLabelText('Credit opening for Capital');
    expect(debit).toHaveValue(100);
    expect(screen.getByRole('button', { name: /save audited openings/i })).toBeEnabled();

    fireEvent.change(credit, { target: { value: '90' } });
    expect(screen.getByText(/out by ₹10.00/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save audited openings/i })).toBeDisabled();
  });

  test('a balanced opening is posted with explicit debit and credit sides', async () => {
    render(<CompanySetupView />);
    await screen.findByLabelText('Debit opening for Cash');
    fireEvent.click(screen.getByRole('button', { name: /save audited openings/i }));
    await waitFor(() => expect(calls.some(c => c.path === '/opening-balances/2026-27')).toBe(true));
    const sent = calls.find(c => c.path === '/opening-balances/2026-27')!.body.entries;
    expect(sent).toEqual(expect.arrayContaining([
      expect.objectContaining({ debit: 100, credit: 0 }),
      expect.objectContaining({ debit: 0, credit: 100 })
    ]));
  });
});
