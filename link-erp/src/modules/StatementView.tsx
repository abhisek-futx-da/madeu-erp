import { useState } from 'react';
import { ToolbarRibbon } from '../components/ToolbarRibbon';
import { useApi } from '../lib/useApi';
import { api } from '../lib/api';

/**
 * Profit & loss and balance sheet. The system had a trial balance and nothing
 * an owner or a CA could read off it directly.
 */

interface Line {
  section: 'income' | 'expense' | 'asset' | 'liability' | 'equity';
  code: string; name: string; control_account: string; amount: number;
}
interface PL { from: string; to: string; rows: Line[]; totals: { income: number; expense: number; netProfit: number } }
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

export const StatementView: React.FC<{ kind: 'profit_loss' | 'balance_sheet' }> = ({ kind }) => {
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(fyStart(today));
  const [to, setTo] = useState(today);

  const path = kind === 'profit_loss'
    ? `/statements/profit-loss?from=${from}&to=${to}`
    : `/statements/balance-sheet?to=${to}`;
  const { data, error, loading, reload } = useApi<PL & BS>(path);

  const rows = data?.rows ?? [];
  const of = (s: Line['section']) => rows.filter(r => r.section === s);
  const sum = (s: Line['section']) =>
    of(s).reduce((n, r) => n + Number(r.amount), 0);

  const title = kind === 'profit_loss' ? 'Profit & Loss' : 'Balance Sheet';
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
        {kind === 'profit_loss' && (
          <label className="flex items-center gap-1">
            From <input type="date" value={from} onChange={e => setFrom(e.target.value)}
              className="border border-slate-300 rounded px-1 py-1" />
          </label>
        )}
        <label className="flex items-center gap-1">
          {kind === 'profit_loss' ? 'To' : 'As on'}
          <input type="date" value={to} onChange={e => setTo(e.target.value)}
            className="border border-slate-300 rounded px-1 py-1" />
        </label>
        {loading && <span className="text-slate-500">Loading…</span>}
      </div>

      {error && <div className="px-4 py-2 bg-red-600 text-white font-semibold">{error}</div>}

      <div className="flex-1 overflow-auto p-3 print-area">
        <div className="bg-white rounded border border-[#b8c9dd] p-3">
          <h2 className="text-center font-bold text-blue-900 text-sm mb-1">{title}</h2>
          <p className="text-center text-slate-500 mb-3">
            {kind === 'profit_loss' ? `${from} to ${to}` : `as on ${to}`}
          </p>

          {kind === 'profit_loss' ? (
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
