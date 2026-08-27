import { useState } from 'react';
import { ToolbarRibbon } from '../components/ToolbarRibbon';
import { useApi } from '../lib/useApi';
import { api } from '../lib/api';

/**
 * The three statements an Indian accountant reads, in the order they are read.
 *
 * Trading first — opening stock, purchases and direct costs against sales and
 * closing stock, balancing to Gross Profit. Then the P&L, which takes that
 * gross profit against indirect income and expenses to reach Net Profit. The
 * Balance Sheet stands on its own.
 *
 * Each reads ledger by ledger or head by head, because an accountant checking
 * a figure and an owner reading the shape of the year want different things
 * from the same numbers.
 */

interface Line {
  /** P&L and balance sheet sections, plus the Trading Account's own. */
  section: string;
  code: string; name: string; control_account: string; amount: number;
}
interface PL { from: string; to: string; rows: Line[]; totals: { income: number; expense: number; netProfit: number } }
interface Trading {
  from: string; to: string; debit: Line[]; credit: Line[];
  totals: {
    openingStock: number; purchases: number; closingStock: number;
    sales: number; costOfGoodsSold: number; otherDirectExpenses: number;
    grossProfit: number; grossProfitPct: number;
    debitTotal: number; creditTotal: number;
    stockAdjustments: number; difference: number;
  };
}
interface BS {
  asOn: string; rows: Line[];
  totals: { assets: number; liabilities: number; equity: number; difference: number };
}

const money = (n: number) =>
  `₹ ${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** 1 April of the financial year containing `iso`. */
function fyStart(iso: string) {
  const d = new Date(iso);
  const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  return `${y}-04-01`;
}

const Column: React.FC<{ title: string; rows: Line[]; total: number }> = ({ title, rows, total }) => (
  <div className="flex-1 min-w-0">
    <table className="w-full text-xs">
      <thead>
        <tr className="bg-slate-100 border-y border-slate-300 text-left">
          <th className="px-2 py-1.5 font-bold text-blue-900" colSpan={2}>{title}</th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 && (
          <tr><td colSpan={2} className="px-2 py-4 text-center text-slate-400">Nothing here</td></tr>
        )}
        {rows.map(r => (
          <tr key={`${r.section}-${r.code}`} className="border-b border-slate-100">
            <td className="px-2 py-1">
              {r.name}
              <span className="text-slate-400 ml-1 font-mono text-[10px]">{r.code}</span>
              <div className="text-[10px] text-slate-500">{r.control_account}</div>
            </td>
            <td className="px-2 py-1 text-right font-mono tabular-nums whitespace-nowrap">
              {money(Number(r.amount))}
            </td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr className="bg-slate-50 border-t-2 border-slate-400 font-bold">
          <td className="px-2 py-1.5">Total</td>
          <td className="px-2 py-1.5 text-right font-mono tabular-nums">{money(total)}</td>
        </tr>
      </tfoot>
    </table>
  </div>
);

/**
 * The two sides of a Trading Account, and the gross profit that balances it.
 *
 * `difference` is the same gross profit reached the other way — sales less
 * cost of goods sold and direct expenses. It should be nothing. When it is
 * not, the stock ledger and the P&L ledgers disagree, and that is a posting
 * defect the reader has to be told about rather than shown a tidy total.
 */
const TradingAccount: React.FC<{ data: Trading | null }> = ({ data }) => {
  if (!data) return <p className="p-8 text-center text-slate-600">Loading…</p>;
  const t = data.totals;
  const profit = t.grossProfit >= 0;

  return (
    <>
      {/* Gross profit is a line in the account, not a note beside it: carried
          down on the Dr side when there is a profit and on the Cr side when
          there is a loss, so both columns total to the same figure and a
          reader can see at a glance that the account balances. */}
      <div className="flex flex-col gap-6 md:flex-row">
        <Column title="Dr" total={t.debitTotal}
          rows={profit ? [...data.debit, {
            section: 'gross_profit', code: '', name: 'Gross Profit c/d',
            control_account: '', amount: t.grossProfit
          }] : data.debit} />
        <Column title="Cr" total={t.creditTotal}
          rows={profit ? data.credit : [...data.credit, {
            section: 'gross_profit', code: '', name: 'Gross Loss c/d',
            control_account: '', amount: -t.grossProfit
          }]} />
      </div>

      <div className={`mt-4 rounded border p-3 text-center text-sm font-bold ${
        profit ? 'bg-emerald-50 border-emerald-300 text-emerald-900'
               : 'bg-red-50 border-red-300 text-red-900'}`}>
        {profit ? 'Gross Profit' : 'Gross Loss'} c/d: {money(Math.abs(t.grossProfit))}
        {t.sales > 0 && <span className="ml-2 font-normal">({t.grossProfitPct.toFixed(2)}% of sales)</span>}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 text-slate-700 sm:grid-cols-4">
        <div><span className="text-slate-600">Opening stock</span>
          <p className="font-mono font-bold">{money(t.openingStock)}</p></div>
        <div><span className="text-slate-600">Purchases and processing</span>
          <p className="font-mono font-bold">{money(t.purchases)}</p></div>
        <div><span className="text-slate-600">Cost of goods sold</span>
          <p className="font-mono font-bold">{money(t.costOfGoodsSold)}</p></div>
        <div><span className="text-slate-600">Closing stock</span>
          <p className="font-mono font-bold">{money(t.closingStock)}</p></div>
      </div>

      {Math.abs(t.stockAdjustments) > 0.01 && (
        <p className="mt-2 text-slate-600">
          Of what left stock, {money(Math.abs(t.stockAdjustments))} went out other than by
          sale — write-off or shortage.
        </p>
      )}

      {Math.abs(t.difference) > 0.01 && (
        <div className="mt-4 rounded border border-red-300 bg-red-50 p-3 text-center font-bold text-red-900">
          Gross profit differs by {money(t.difference)} depending how it is computed —
          the stock ledger and the trading ledgers disagree, and the books need attention.
        </div>
      )}
    </>
  );
};

export const StatementView: React.FC<{
  kind: 'trading' | 'profit_loss' | 'balance_sheet';
}> = ({ kind }) => {
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(fyStart(today));
  const [to, setTo] = useState(today);
  const [view, setView] = useState<'details' | 'summary'>('details');

  const path = kind === 'balance_sheet'
    ? `/statements/balance-sheet?to=${to}&view=${view}`
    : `/statements/${kind === 'trading' ? 'trading' : 'profit-loss'}` +
      `?from=${from}&to=${to}&view=${view}`;
  const { data, error, loading, reload } = useApi<PL & BS & Trading>(path);

  const rows = data?.rows ?? [];
  const of = (s: Line['section']) => rows.filter(r => r.section === s);
  const sum = (s: Line['section']) =>
    of(s).reduce((n, r) => n + Number(r.amount), 0);

  const title = kind === 'trading' ? 'Trading Account'
    : kind === 'profit_loss' ? 'Profit & Loss' : 'Balance Sheet';
  const exportCsv = () => api.download(`${path}${path.includes('?') ? '&' : '?'}format=csv`, title);

  return (
    <div className="flex flex-col h-full bg-[#ecf1f7] text-slate-800 text-xs">
      <ToolbarRibbon
        title={title}
        actions={[
          { key: 'reset', onRun: reload, hint: 'Refresh (Esc)' },
          { key: 'export', onRun: () => void exportCsv() },
          { key: 'print', onRun: () => window.print() }
        ]}
      />

      <div className="flex items-center gap-3 px-3 py-2 bg-slate-50 border-b border-slate-200 print:hidden">
        {kind !== 'balance_sheet' && (
          <label className="flex items-center gap-1">
            From <input type="date" aria-label="From date" value={from}
              onChange={e => setFrom(e.target.value)}
              className="border border-slate-300 rounded px-1 py-1" />
          </label>
        )}
        <label className="flex items-center gap-1">
          {kind === 'balance_sheet' ? 'As on' : 'To'}
          <input type="date" aria-label={kind === 'balance_sheet' ? 'As on date' : 'To date'}
            value={to} onChange={e => setTo(e.target.value)}
            className="border border-slate-300 rounded px-1 py-1" />
        </label>
        <label className="flex items-center gap-1">View
          <select aria-label="View" className="erp-input min-h-11"
            value={view} onChange={e => setView(e.target.value as 'details' | 'summary')}>
            <option value="details">In details</option>
            <option value="summary">In summary</option>
          </select>
        </label>
        {loading && <span className="text-slate-500">Loading…</span>}
      </div>

      {error && <div className="px-4 py-2 bg-red-600 text-white font-semibold">{error}</div>}

      <div className="flex-1 overflow-auto p-3 print-area">
        <div className="bg-white rounded border border-[#b8c9dd] p-3">
          <h2 className="text-center font-bold text-blue-900 text-sm mb-1">{title}</h2>
          <p className="text-center text-slate-500 mb-3">
            {kind === 'balance_sheet' ? `as on ${to}` : `${from} to ${to}`}
          </p>

          {kind === 'trading' ? <TradingAccount data={data} /> : kind === 'profit_loss' ? (
            <>
              <div className="flex gap-6 flex-col md:flex-row">
                <Column title="Expenditure" rows={of('expense')} total={sum('expense')} />
                <Column title="Income" rows={of('income')} total={sum('income')} />
              </div>
              <div className={`mt-4 p-3 rounded border text-center font-bold text-sm ${
                (data?.totals?.netProfit ?? 0) >= 0
                  ? 'bg-emerald-50 border-emerald-300 text-emerald-900'
                  : 'bg-red-50 border-red-300 text-red-900'
              }`}>
                {(data?.totals?.netProfit ?? 0) >= 0 ? 'Net Profit' : 'Net Loss'}:{' '}
                {money(Math.abs(data?.totals?.netProfit ?? 0))}
              </div>
            </>
          ) : (
            <>
              <div className="flex gap-6 flex-col md:flex-row">
                <Column title="Liabilities & Equity"
                  rows={[...of('liability'), ...of('equity')]}
                  total={sum('liability') + sum('equity')} />
                <Column title="Assets" rows={of('asset')} total={sum('asset')} />
              </div>
              {/* A sheet that does not balance is a posting defect, not a display one. */}
              {Math.abs(data?.totals?.difference ?? 0) > 0.01 && (
                <div className="mt-4 p-3 rounded border bg-red-50 border-red-300 text-red-900 text-center font-bold">
                  Out of balance by {money(data?.totals?.difference ?? 0)} — the books need attention
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};
