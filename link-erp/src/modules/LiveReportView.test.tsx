import { beforeEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LiveReportView } from './LiveReportView';
import { clearApiCache } from '../lib/useApi';

const LEDGERS = [
  { code: '101', name: 'Cash', control_account: 'Assets', total_debit: 100, total_credit: 0, balance: 100 },
  { code: '201', name: 'Supplier', control_account: 'Liabilities', total_debit: 0, total_credit: 100, balance: -100 }
];

/** Answers like the API does: the search is a query, not a pass over the page. */
function mockApi(over: { asked?: string[] } = {}) {
  clearApiCache();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const full = String(url).replace(/^.*\/api/, '');
    const [path, search = ''] = full.split('?');
    over.asked?.push(full);
    if (init?.method === 'POST') {
      return { ok: true, status: 201, headers: new Headers(),
               text: async () => JSON.stringify({ id: 'saved' }) } as Response;
    }
    const q = new URLSearchParams(search).get('q') ?? '';
    const matching = LEDGERS.filter(l =>
      !q || `${l.code} ${l.name} ${l.control_account}`.toLowerCase().includes(q.toLowerCase()));

    let body: unknown = [];
    if (path === '/report-catalogue') {
      body = [{ name: 'trial-balance', hasPeriod: false, totals: ['total_debit', 'total_credit'] },
              { name: 'cash-book', hasPeriod: true, totals: ['inflow', 'outflow'] }];
    } else if (path?.endsWith('/summary')) {
      body = {
        total: matching.length,
        totals: {
          total_debit: matching.reduce((n, l) => n + l.total_debit, 0),
          total_credit: matching.reduce((n, l) => n + l.total_credit, 0)
        }
      };
    } else if (path === '/saved-views') {
      body = [{ id: 'v1', name: 'Compact cash', filter_text: 'Cash',
                columns: ['code', 'name'], updated_at: '2026-08-26' }];
    } else if (path?.startsWith('/reports/')) {
      body = matching;
    }
    return { ok: true, status: 200, headers: new Headers(),
             text: async () => JSON.stringify(body) } as Response;
  }));
}

describe('LiveReportView', () => {
  beforeEach(() => mockApi());

  test('a blank GST report explains what is missing and opens the right workflow', async () => {
    clearApiCache();
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, headers: new Headers(), text: async () => '[]'
    } as unknown as Response)));
    const onOpen = vi.fn();
    render(<LiveReportView report="gst_liability" onOpen={onOpen} />);

    await waitFor(() => expect(screen.getByText(/No approved GST documents/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Open tax invoices/i }));
    expect(onOpen).toHaveBeenCalledWith('sales_invoices');
  });

  test('a user applies and saves a personal filter with its visible export columns', async () => {
    const writes: unknown[] = [];
    const asked: string[] = [];
    mockApi({ asked });
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const full = String(url).replace(/^.*\/api/, '');
      const [path, search = ''] = full.split('?');
      if (init?.method === 'POST') {
        writes.push(JSON.parse(String(init.body)));
        return { ok: true, status: 201, headers: new Headers(),
                 text: async () => JSON.stringify({ id: 'saved' }) } as Response;
      }
      const q = new URLSearchParams(search).get('q') ?? '';
      const matching = LEDGERS.filter(l => !q || l.name.toLowerCase().includes(q.toLowerCase()));
      const body = path === '/saved-views'
        ? [{ id: 'v1', name: 'Compact cash', filter_text: 'Cash',
             columns: ['code', 'name'], updated_at: '2026-08-26' }]
        : path === '/report-catalogue'
          ? [{ name: 'trial-balance', hasPeriod: false, totals: [] }]
          : path?.endsWith('/summary') ? { total: matching.length, totals: {} } : matching;
      return { ok: true, status: 200, headers: new Headers(),
               text: async () => JSON.stringify(body) } as Response;
    }));

    render(<LiveReportView report="trial_balance" />);
    await screen.findByText('Supplier');

    fireEvent.change(screen.getByLabelText('Saved report'), { target: { value: 'v1' } });
    // The saved filter is sent to the server, which is what narrows the report.
    await waitFor(() => expect(screen.queryByText('Supplier')).not.toBeInTheDocument());
    expect(screen.queryByRole('columnheader', { name: 'Control A/c' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /save current/i }));
    await waitFor(() => expect(writes).toContainEqual({
      module: 'report:trial_balance', name: 'Compact cash',
      filterText: 'Cash', columns: ['code', 'name']
    }));
  });

  test('the search reaches the server rather than filtering the fetched page', async () => {
    const asked: string[] = [];
    mockApi({ asked });
    render(<LiveReportView report="trial_balance" />);
    await screen.findByText('Supplier');

    fireEvent.change(screen.getByLabelText('Search this report'), { target: { value: 'Cash' } });
    await waitFor(() => expect(asked.some(u => u.includes('q=Cash'))).toBe(true));
    await waitFor(() => expect(screen.queryByText('Supplier')).not.toBeInTheDocument());
  });

  test('a report footer totals the whole report, and says how many rows it counted', async () => {
    render(<LiveReportView report="trial_balance" />);
    await screen.findByText('Supplier');

    const footer = await screen.findByText(/Total \(2 rows\)/);
    const row = footer.closest('tr')!;
    // 100.00 debit and 100.00 credit across both ledgers, from the summary call.
    expect(row.textContent).toContain('100.00');
  });

  test('a position report offers no date range and says why', async () => {
    render(<LiveReportView report="trial_balance" />);
    await screen.findByText('Supplier');

    expect(screen.getByText(/Position as on today/i)).toBeInTheDocument();
    expect(screen.queryByLabelText('From date')).not.toBeInTheDocument();
  });

  test('a period report offers a date range and sends it', async () => {
    const asked: string[] = [];
    mockApi({ asked });
    render(<LiveReportView report="cash_book" />);

    const fromBox = await screen.findByLabelText('From date');
    fireEvent.change(fromBox, { target: { value: '2026-04-01' } });
    fireEvent.change(screen.getByLabelText('To date'), { target: { value: '2026-06-30' } });

    await waitFor(() => expect(
      asked.some(u => u.includes('from=2026-04-01') && u.includes('to=2026-06-30'))).toBe(true));
  });
});

describe('group subtotals', () => {
  const ROWS = [
    { party: 'Bombay Crimpers', invoice_no: 'INV-1', invoice_total: 100 },
    { party: 'Bombay Crimpers', invoice_no: 'INV-2', invoice_total: 250 },
    { party: 'Prayag Texprint', invoice_no: 'INV-3', invoice_total: 400 }
  ];

  function mockGrouped() {
    clearApiCache();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const path = String(url).replace(/^.*\/api/, '').split('?')[0]!;
      const body = path === '/report-catalogue'
        ? [{ name: 'sales-register', hasPeriod: true, totals: ['invoice_total'], groupBy: 'party' }]
        : path.endsWith('/summary')
          ? {
              total: 3, totals: { invoice_total: 750 },
              groups: [
                { label: 'Bombay Crimpers', rows: 2, totals: { invoice_total: 350 } },
                { label: 'Prayag Texprint', rows: 1, totals: { invoice_total: 400 } }
              ]
            }
          : path.startsWith('/reports/') ? ROWS : [];
      return { ok: true, status: 200, headers: new Headers(),
               text: async () => JSON.stringify(body) } as Response;
    }));
  }

  test('a subtotal closes each party, the way a mill reads a register', async () => {
    mockGrouped();
    render(<LiveReportView report="sales_register" />);

    expect(await screen.findByText('TOTAL OF Bombay Crimpers')).toBeInTheDocument();
    expect(screen.getByText('TOTAL OF Prayag Texprint')).toBeInTheDocument();
  });

  test('the subtotals add up to the report total', async () => {
    mockGrouped();
    render(<LiveReportView report="sales_register" />);

    const first = (await screen.findByText('TOTAL OF Bombay Crimpers')).closest('tr')!;
    expect(first.textContent).toContain('350');
    // 350 + 400 = 750, which is what the footer says.
    expect(screen.getByText(/Total \(3 rows\)/).closest('tr')!.textContent).toContain('750');
  });
});
