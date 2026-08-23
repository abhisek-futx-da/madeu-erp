import { beforeEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MillIntegrationView } from './MillIntegrationView';

const INVOICE = '00000000-0000-0000-0000-000000000501';
const PARTY = '00000000-0000-0000-0000-000000000701';
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const pathWithQuery = String(url).replace(/^.*\/api/, '');
    const path = pathWithQuery.split('?')[0]!;
    if ((init?.method ?? 'GET') === 'POST') {
      return { ok: true, status: 201, headers: new Headers(),
        text: async () => JSON.stringify({ id: '00000000-0000-0000-0000-000000009999', state: 'pending' }) } as Response;
    }
    const bodies: Record<string, unknown> = {
      '/process-house-bills/available-receipts': [],
      '/process-house-bills': [],
      '/sales-invoices': { rows: [{ id: INVOICE, invoice_no: 'NKT/26-27/1', party_name: 'Supreme Textiles',
        invoice_total: 10500, status: 'approved' }], total: 1, limit: 200, offset: 0 },
      '/reports/outstanding-sales': [{ party_id: PARTY, party: 'Supreme Textiles',
        outstanding: 10500, overdue_days: 31 }],
      '/notifications': { providerConfigured: false, rows: [] }
    };
    return { ok: true, status: 200, headers: new Headers(),
      text: async () => JSON.stringify(bodies[path] ?? []) } as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
});

describe('MillIntegrationView messaging desk', () => {
  test('queues a broker copy of an approved invoice explicitly', async () => {
    render(<MillIntegrationView />);
    await screen.findByRole('option', { name: /NKT\/26-27\/1/ });
    fireEvent.change(screen.getByLabelText('Invoice to message'), { target: { value: INVOICE } });
    fireEvent.change(screen.getByLabelText('Invoice recipient'), { target: { value: 'broker' } });
    fireEvent.click(screen.getByRole('button', { name: 'Queue invoice' }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) =>
      String(url).endsWith(`/notifications/invoices/${INVOICE}`) &&
      JSON.parse(String((init as RequestInit).body)).recipient === 'broker')).toBe(true));
    expect(await screen.findByText('Invoice message queued as pending')).toBeInTheDocument();
  });

  test('queues an outstanding-statement reminder for the selected customer', async () => {
    render(<MillIntegrationView />);
    await screen.findByRole('option', { name: /Supreme Textiles.*due/ });
    const select = screen.getByLabelText('Customer for payment reminder');
    fireEvent.change(select, { target: { value: PARTY } });
    fireEvent.click(screen.getByRole('button', { name: 'Queue reminder' }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) =>
      String(url).endsWith(`/notifications/reminders/${PARTY}`) &&
      JSON.parse(String((init as RequestInit).body)).asOf)).toBe(true));
    expect(await screen.findByText('Payment reminder queued as pending')).toBeInTheDocument();
  });
});
