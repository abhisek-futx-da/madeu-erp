import { describe, test, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StatementView } from './StatementView';
import { DashboardView } from './DashboardView';

/**
 * A balance sheet that silently does not balance is worse than none: it looks
 * authoritative. The server sends a `difference`; this screen must say so
 * loudly when it is not zero, and stay quiet when it is.
 */

function mockJson(body: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true, status: 200, headers: new Headers(),
    text: async () => JSON.stringify(body)
  } as unknown as Response)));
}

const BALANCED = {
  asOn: '2027-03-31',
  rows: [
    { section: 'asset', code: '960', name: 'Grey Stock', control_account: 'Current Assets - Stock', amount: 5643000 },
    { section: 'liability', code: '105', name: 'L.R. Textiles', control_account: 'Creditors For Grey', amount: 6980113.8 },
    { section: 'equity', code: '999', name: 'Loss for the period', control_account: 'Reserves & Surplus', amount: -1337113.8 }
  ],
  totals: { assets: 5643000, liabilities: 6980113.8, equity: -1337113.8, difference: 0 }
};

describe('StatementView — balance sheet', () => {
  test('renders both sides with their totals', async () => {
    mockJson(BALANCED);
    render(<StatementView kind="balance_sheet" />);

    await waitFor(() => expect(screen.getByText('Grey Stock')).toBeInTheDocument());
    expect(screen.getByText('Liabilities & Equity')).toBeInTheDocument();
    expect(screen.getByText('Assets')).toBeInTheDocument();
    // Inventory belongs on the asset side, which is the classification bug the
    // audit found and this pins down.
    expect(screen.getByText('Current Assets - Stock')).toBeInTheDocument();
  });

  test('says nothing about balance when it balances', async () => {
    mockJson(BALANCED);
    render(<StatementView kind="balance_sheet" />);
    await waitFor(() => expect(screen.getByText('Grey Stock')).toBeInTheDocument());
    expect(screen.queryByText(/out of balance/i)).toBeNull();
  });

  test('shouts when the two sides disagree', async () => {
    mockJson({ ...BALANCED, totals: { ...BALANCED.totals, difference: 2443989.4 } });
    render(<StatementView kind="balance_sheet" />);
    await waitFor(() =>
      expect(screen.getByText(/out of balance by/i)).toBeInTheDocument());
    expect(screen.getByText(/books need attention/i)).toBeInTheDocument();
  });

  test('a loss is labelled a loss, not a negative profit', async () => {
    mockJson({
      from: '2026-04-01', to: '2027-03-31',
      rows: [
        { section: 'income', code: '901', name: 'Trading Sales', control_account: 'Sales', amount: 727184 },
        { section: 'expense', code: '900', name: 'Trading Purchase', control_account: 'Purchases', amount: 1221994.7 }
      ],
      totals: { income: 727184, expense: 1221994.7, netProfit: -494810.7 }
    });
    render(<StatementView kind="profit_loss" />);
    await waitFor(() => expect(screen.getByText(/Net Loss/)).toBeInTheDocument());
    // Shown as a positive magnitude beside the word "Loss", not "-494810.70".
    expect(screen.getByText(/₹ 4,94,810.70/)).toBeInTheDocument();
  });
});

describe('DashboardView', () => {
  const SUMMARY = {
    summary: {
      sales_today: 0, sales_mtd: 740904, sales_ytd: 740904,
      receivables: 697721, receivables_overdue: 25000, payables: 620505,
      cash_and_bank: 90465, stock_value: 6238432.7, stock_pieces: 2058,
      pieces_at_dyeing: 1809, qty_at_dyeing: 180900,
      invoices_awaiting_irn: 63, challans_beyond_one_year: 2, overdue_orders: 0
    },
    trend: [{ month: '2026-09', taxable_value: 740904, invoices: 63 }],
    topDebtors: [
      { party: 'Supreme Textile', code: '701', outstanding: 550159,
        overdue: 25000, worst_overdue_days: 12, bills: 48 }
    ]
  };

  test('reports lakhs and crores the way an owner reads them', async () => {
    mockJson(SUMMARY);
    render(<DashboardView />);
    await waitFor(() => expect(screen.getByText(/62.38 L/)).toBeInTheDocument());
    expect(screen.getByText(/6.98 L overdue|₹ 6.98 L/)).toBeTruthy();
  });

  test('flags job work past the twelve-month limit as a problem, not a statistic', async () => {
    mockJson(SUMMARY);
    render(<DashboardView />);
    await waitFor(() =>
      expect(screen.getByText(/ITC reverses after twelve months/i)).toBeInTheDocument());
    const tile = screen.getByText(/JOB WORK PAST 1 YEAR/i).closest('div')!.parentElement!;
    expect(tile.className).toMatch(/red/);
  });

  test('a clean position is not dressed up as an alarm', async () => {
    mockJson({
      ...SUMMARY,
      summary: { ...SUMMARY.summary, challans_beyond_one_year: 0, receivables_overdue: 0 }
    });
    render(<DashboardView />);
    await waitFor(() => expect(screen.getByText(/nothing overdue/i)).toBeInTheDocument());
    const tile = screen.getByText(/JOB WORK PAST 1 YEAR/i).closest('div')!.parentElement!;
    expect(tile.className).toMatch(/emerald/);
  });

  test('an empty year says so rather than drawing an empty chart', async () => {
    mockJson({ ...SUMMARY, trend: [], topDebtors: [] });
    render(<DashboardView />);
    await waitFor(() =>
      expect(screen.getByText(/Nothing invoiced yet this year/i)).toBeInTheDocument());
    expect(screen.getByText(/Every bill is settled/i)).toBeInTheDocument();
  });

  test('a new company is given the real first-day workflow, not a blank dashboard', async () => {
    const onOpen = vi.fn();
    mockJson({
      summary: {
        sales_today: 0, sales_mtd: 0, sales_ytd: 0, receivables: 0, receivables_overdue: 0,
        payables: 0, cash_and_bank: 0, stock_value: 0, stock_pieces: 0,
        pieces_at_dyeing: 0, qty_at_dyeing: 0, invoices_awaiting_irn: 0,
        challans_beyond_one_year: 0, overdue_orders: 0
      }, trend: [], topDebtors: []
    });
    render(<DashboardView onOpen={onOpen} />);
    await waitFor(() => expect(screen.getByText(/Start your first working day/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Record grey inward/i }));
    expect(onOpen).toHaveBeenCalledWith('grey_inward');
  });
});

describe('the Trading Account', () => {
  const trading = {
    from: '2026-04-01', to: '2027-03-31',
    debit: [
      { section: 'opening_stock', code: '', name: 'Opening Stock', control_account: 'Stock', amount: 100000 },
      { section: 'purchases', code: '', name: 'Purchases and Processing', control_account: 'Stock', amount: 500000 }
    ],
    credit: [
      { section: 'trading_income', code: '901', name: 'Trading Sales A/c', control_account: 'Trading Sales', amount: 800000 },
      { section: 'closing_stock', code: '', name: 'Closing Stock', control_account: 'Stock', amount: 50000 }
    ],
    totals: {
      openingStock: 100000, purchases: 500000, closingStock: 50000,
      sales: 800000, costOfGoodsSold: 550000, otherDirectExpenses: 0,
      grossProfit: 250000, grossProfitPct: 31.25,
      debitTotal: 850000, creditTotal: 850000,
      stockAdjustments: 0, difference: 0
    }
  };

  function mockTrading(over: Record<string, unknown> = {}) {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, headers: new Headers(),
      text: async () => JSON.stringify({ ...trading, ...over })
    } as unknown as Response)));
  }

  test('shows both sides and the gross profit that balances them', async () => {
    mockTrading();
    render(<StatementView kind="trading" />);

    expect(await screen.findByText(/Gross Profit c\/d/)).toBeInTheDocument();
    expect(screen.getByText(/31.25% of sales/)).toBeInTheDocument();
    expect(screen.getAllByText(/Purchases and Processing/).length).toBeGreaterThan(0);
  });

  test('a gross loss is named as one, not shown as a negative profit', async () => {
    mockTrading({ totals: { ...trading.totals, grossProfit: -40000, grossProfitPct: -5 } });
    render(<StatementView kind="trading" />);
    expect(await screen.findByText(/Gross Loss c\/d/)).toBeInTheDocument();
  });

  /**
   * The two routes to gross profit must agree. When they do not, the reader
   * has to be told the books need attention rather than shown a tidy total.
   */
  test('a disagreement between the two routes is surfaced, not hidden', async () => {
    mockTrading({ totals: { ...trading.totals, difference: 1234.5 } });
    render(<StatementView kind="trading" />);
    expect(await screen.findByText(/the books need attention/)).toBeInTheDocument();
  });

  test('goods that left stock other than by sale are called out', async () => {
    mockTrading({ totals: { ...trading.totals, stockAdjustments: -8000 } });
    render(<StatementView kind="trading" />);
    expect(await screen.findByText(/other than by\s+sale/)).toBeInTheDocument();
  });

  test('a statement can be read in details or in summary', async () => {
    const asked: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      asked.push(String(url));
      return { ok: true, status: 200, headers: new Headers(),
               text: async () => JSON.stringify(trading) } as unknown as Response;
    }));
    render(<StatementView kind="trading" />);
    await screen.findByText(/Gross Profit c\/d/);

    fireEvent.change(screen.getByLabelText('View'), { target: { value: 'summary' } });
    await waitFor(() => expect(asked.some(u => u.includes('view=summary'))).toBe(true));
  });
});
