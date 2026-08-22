import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { ApprovalView } from './ApprovalView';
import type { Session } from '../lib/api';

/**
 * The rule worth testing on this screen is that it never invites someone to
 * approve a document they cannot approve. The server refuses either way; a
 * button that fails when clicked is still a bad screen.
 */

const OWNER: Session = {
  userId: 'user-owner', tenantId: 't1', role: 'owner',
  tenant: { legalName: 'Neelkamal Textiles', gstin: '27ANBPC3604Q1Z0', fyLabel: '2026-27' },
  user: { email: 'owner@neelkamal.test', fullName: 'Owner' }
};

const pendingRow = (over: Record<string, unknown> = {}) => ({
  doc_type: 'sales_invoice', doc_id: 'inv-1', doc_no: 'NKT/26-27/91',
  doc_date: '2026-09-10', amount: 665000, party: 'Supreme Textile And Garments',
  raised_by: 'user-clerk', raised_by_name: 'Sales Desk',
  created_at: '2026-09-10T04:00:00Z', approver_role: 'owner',
  min_amount: 500000, waiting_days: 4, ...over
});

function mockApi(routes: Record<string, unknown>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url).replace(/^.*\/api/, '');
    const key = `${init?.method ?? 'GET'} ${path.split('?')[0]}`;
    const body = routes[key] ?? routes[path.split('?')[0]!] ?? [];
    return {
      ok: true, status: 200, headers: new Headers(),
      text: async () => JSON.stringify(body)
    } as unknown as Response;
  }));
}

beforeEach(() => {
  mockApi({
    '/approvals/pending': [pendingRow()],
    '/approvals/history': [],
    '/approval-rules': [
      { doc_type: 'sales_invoice', min_amount: 500000, approver_role: 'owner', is_active: true },
      { doc_type: 'payment', min_amount: 100000, approver_role: 'accounts', is_active: true }
    ]
  });
});

describe('ApprovalView', () => {
  test('shows what is held, by whom, and for how long', async () => {
    render(<ApprovalView session={OWNER} />);
    await waitFor(() => expect(screen.getByText('NKT/26-27/91')).toBeInTheDocument());

    expect(screen.getByText(/Waiting for a second signature \(1\)/)).toBeInTheDocument();
    expect(screen.getByText('Sales Desk')).toBeInTheDocument();
    expect(screen.getByText('4d')).toBeInTheDocument();
    expect(screen.getAllByText(/₹6,65,000/).length).toBeGreaterThan(0);
  });

  test('the approve button is live for a checker who did not raise it', async () => {
    render(<ApprovalView session={OWNER} />);
    const approve = await screen.findByRole('button', { name: /approve/i });
    expect(approve).toBeEnabled();
  });

  test('the maker cannot approve their own document', async () => {
    mockApi({
      '/approvals/pending': [pendingRow({ raised_by: 'user-owner', raised_by_name: 'Owner' })],
      '/approvals/history': [], '/approval-rules': []
    });
    render(<ApprovalView session={OWNER} />);
    const approve = await screen.findByRole('button', { name: /approve/i });
    expect(approve).toBeDisabled();
    expect(approve).toHaveAttribute('title', expect.stringContaining('you raised this one'));
  });

  test('someone without the required role is told so rather than left to fail', async () => {
    const clerk: Session = { ...OWNER, userId: 'user-clerk-2', role: 'store' };
    mockApi({
      '/approvals/pending': [pendingRow({ approver_role: 'accounts' })],
      '/approvals/history': [], '/approval-rules': []
    });
    render(<ApprovalView session={clerk} />);
    const approve = await screen.findByRole('button', { name: /approve/i });
    expect(approve).toBeDisabled();
    expect(approve).toHaveAttribute('title', expect.stringContaining('accounts'));
  });

  test('an empty queue says so plainly', async () => {
    mockApi({ '/approvals/pending': [], '/approvals/history': [], '/approval-rules': [] });
    render(<ApprovalView session={OWNER} />);
    await waitFor(() =>
      expect(screen.getByText(/every document is posted/i)).toBeInTheDocument());
  });

  test('the limits in force are shown, so nobody guesses the threshold', async () => {
    render(<ApprovalView session={OWNER} />);
    await waitFor(() => expect(screen.getByText('Limits in force')).toBeInTheDocument());
    expect(screen.getByText(/₹5,00,000/)).toBeInTheDocument();
    expect(screen.getByText('accounts')).toBeInTheDocument();
  });

  test('approving posts to the server and reports the voucher it created', async () => {
    const calls: string[] = [];
    vi.stubGlobal('prompt', vi.fn(() => 'checked against the order'));
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url).replace(/^.*\/api/, '');
      if (init?.method === 'POST') {
        calls.push(path);
        return {
          ok: true, status: 200, headers: new Headers(),
          text: async () => JSON.stringify({ docNo: 'NKT/26-27/91', voucherNo: 'SV/26-27/12' })
        } as unknown as Response;
      }
      const body = path.startsWith('/approvals/pending') ? [pendingRow()] : [];
      return {
        ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify(body)
      } as unknown as Response;
    }));

    render(<ApprovalView session={OWNER} />);
    fireEvent.click(await screen.findByRole('button', { name: /approve/i }));

    await waitFor(() => expect(calls).toContain('/approvals/sales_invoice/inv-1/approve'));
    await waitFor(() =>
      expect(screen.getByText(/posted as SV\/26-27\/12/)).toBeInTheDocument());
  });

  test('a rejection without a reason is not sent at all', async () => {
    const calls: string[] = [];
    vi.stubGlobal('prompt', vi.fn(() => null));
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url).replace(/^.*\/api/, '');
      if (init?.method === 'POST') calls.push(path);
      const body = path.startsWith('/approvals/pending') ? [pendingRow()] : [];
      return {
        ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify(body)
      } as unknown as Response;
    }));

    render(<ApprovalView session={OWNER} />);
    await screen.findByRole('button', { name: /approve/i });
    const reject = screen.getAllByRole('button')
      .find(b => (b.getAttribute('title') ?? '').includes('Send back'));
    expect(reject).toBeTruthy();
    fireEvent.click(reject!);

    await new Promise(r => setTimeout(r, 20));
    expect(calls).toEqual([]);
  });

  test('a server refusal is surfaced, not swallowed', async () => {
    vi.stubGlobal('prompt', vi.fn(() => 'note'));
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url).replace(/^.*\/api/, '');
      if (init?.method === 'POST') {
        return {
          ok: false, status: 400, headers: new Headers(),
          text: async () => JSON.stringify({ error: 'was raised by you; approval needs a second person' })
        } as unknown as Response;
      }
      const body = path.startsWith('/approvals/pending') ? [pendingRow()] : [];
      return {
        ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify(body)
      } as unknown as Response;
    }));

    render(<ApprovalView session={OWNER} />);
    fireEvent.click(await screen.findByRole('button', { name: /approve/i }));
    await waitFor(() =>
      expect(screen.getByText(/needs a second person/)).toBeInTheDocument());
  });
});
