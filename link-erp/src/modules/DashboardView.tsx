import React from 'react';
import {
  TrendingUp, Wallet, AlertTriangle, Package, Factory, FileWarning, Clock, Banknote
} from 'lucide-react';
import { useApi } from '../lib/useApi';
import { ToolbarRibbon } from '../components/ToolbarRibbon';

/**
 * What the owner sees at nine in the morning. The app used to open on a
 * barcode-lookup screen, which answers a question nobody starts the day with.
 */

interface Summary {
  sales_today: number; sales_mtd: number; sales_ytd: number;
  receivables: number; receivables_overdue: number; payables: number;
  cash_and_bank: number; stock_value: number; stock_pieces: number;
  pieces_at_dyeing: number; qty_at_dyeing: number;
  invoices_awaiting_irn: number; challans_beyond_one_year: number; overdue_orders: number;
}
interface TrendRow { month: string; taxable_value: number; invoices: number }
interface DebtorRow {
  party: string; code: string; outstanding: number; overdue: number;
  worst_overdue_days: number; bills: number;
}

const inr = (n: number) =>
  new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Math.round(n));

/** Indian shorthand: an owner reads 12.4L faster than 1,240,000. */
function short(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 10_000_000) return `${(n / 10_000_000).toFixed(2)} Cr`;
  if (abs >= 100_000) return `${(n / 100_000).toFixed(2)} L`;
  return inr(n);
}

const Tile: React.FC<{
  label: string; value: string; sub?: string; icon: React.ElementType;
  tone?: 'good' | 'warn' | 'bad' | 'plain';
}> = ({ label, value, sub, icon: Icon, tone = 'plain' }) => {
  const tones = {
    good:  'border-emerald-300 bg-emerald-50 text-emerald-900',
    warn:  'border-amber-300 bg-amber-50 text-amber-900',
    bad:   'border-red-300 bg-red-50 text-red-900',
    plain: 'border-slate-300 bg-white text-slate-800'
  } as const;
  return (
    <div className={`border rounded-lg p-3 shadow-2xs ${tones[tone]}`}>
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide opacity-70">
        <Icon className="w-3.5 h-3.5" />
        {label}
      </div>
      <div className="text-xl font-bold tabular-nums mt-1">{value}</div>
      {sub && <div className="text-[11px] opacity-70 mt-0.5">{sub}</div>}
    </div>
  );
};

export const DashboardView: React.FC<{ onOpen?: (moduleKey: string) => void }> = ({ onOpen }) => {
  const { data, error, loading, reload } =
    useApi<{ summary: Summary; trend: TrendRow[]; topDebtors: DebtorRow[] }>('/dashboard');

  if (loading) return <div className="p-6 text-sm text-slate-500">Loading today's position…</div>;
  if (error) return <div className="p-6 text-sm text-red-700">{error}</div>;
  if (!data?.summary) return <div className="p-6 text-sm text-slate-500">No data yet.</div>;

  const s = data.summary;
  const peak = Math.max(1, ...data.trend.map(t => Number(t.taxable_value)));
  const isFirstWorkingDay =
    Number(s.stock_pieces) === 0 && Number(s.sales_ytd) === 0 &&
    Number(s.receivables) === 0 && Number(s.payables) === 0;

  return (
    <div className="flex flex-col h-full overflow-auto">
      <ToolbarRibbon
        title="Dashboard"
        actions={[
          { key: 'reset', onRun: reload, hint: 'Refresh (Esc)' },
          { key: 'print', onRun: () => window.print() }
        ]}
      />

      <div className="p-4 print-area">
        {isFirstWorkingDay && onOpen && (
          <section className="mb-4 rounded-lg border border-blue-300 bg-blue-50 p-4 print:hidden">
            <h2 className="text-sm font-bold text-blue-950">Start your first working day</h2>
            <p className="mt-1 text-xs text-blue-900">
              Your books are empty, which is normal for a new company. Enter live documents in this order;
              do not add pretend invoices to a real mill’s books.
            </p>
            <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-5">
              {[
                ['qualities', '1. Check masters'],
                ['grey_inward', '2. Record grey inward'],
                ['dyeing_issue', '3. Issue to dyeing'],
                ['dyeing_receipt', '4. Receive from dyeing'],
                ['dispatch', '5. Dispatch & invoice']
              ].map(([key, label]) => (
                <button key={key} onClick={() => onOpen(key!)} className="erp-btn erp-btn-primary justify-center">
                  {label}
                </button>
              ))}
            </div>
          </section>
        )}

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Tile label="Sales today" value={`₹ ${inr(s.sales_today)}`}
            sub={`Month ₹ ${short(s.sales_mtd)} · Year ₹ ${short(s.sales_ytd)}`}
            icon={TrendingUp} tone={s.sales_today > 0 ? 'good' : 'plain'} />
          <Tile label="Receivable" value={`₹ ${short(s.receivables)}`}
            sub={s.receivables_overdue > 0 ? `₹ ${short(s.receivables_overdue)} overdue` : 'nothing overdue'}
            icon={Wallet} tone={s.receivables_overdue > 0 ? 'warn' : 'plain'} />
          <Tile label="Payable" value={`₹ ${short(s.payables)}`} icon={Banknote} />
          <Tile label="Cash & bank" value={`₹ ${short(s.cash_and_bank)}`}
            icon={Wallet} tone={s.cash_and_bank < 0 ? 'bad' : 'good'} />

          <Tile label="Stock value" value={`₹ ${short(s.stock_value)}`}
            sub={`${inr(s.stock_pieces)} pieces on hand`} icon={Package} />
          <Tile label="At the dyeing house" value={`${inr(s.pieces_at_dyeing)} pcs`}
            sub={`${inr(s.qty_at_dyeing)} mtr out for processing`} icon={Factory} />
          <Tile label="Awaiting IRN" value={inr(s.invoices_awaiting_irn)}
            sub="invoices not yet sent to the IRP" icon={FileWarning}
            tone={s.invoices_awaiting_irn > 0 ? 'warn' : 'good'} />
          <Tile label="Job work past 1 year" value={inr(s.challans_beyond_one_year)}
            sub="s.143(1) — ITC reverses after twelve months" icon={AlertTriangle}
            tone={s.challans_beyond_one_year > 0 ? 'bad' : 'good'} />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-4">
          <section className="border border-slate-300 rounded-lg bg-white p-3">
            <h3 className="text-xs font-bold uppercase tracking-wide text-slate-600 mb-3">
              Sales this financial year
            </h3>
            {data.trend.length === 0 ? (
              <p className="text-xs text-slate-500">Nothing invoiced yet this year.</p>
            ) : (
              <div className="space-y-1.5">
                {data.trend.map(t => (
                  <div key={t.month} className="flex items-center gap-2 text-xs">
                    <span className="w-16 text-slate-600 tabular-nums">{t.month}</span>
                    <div className="flex-1 bg-slate-100 rounded h-4 overflow-hidden">
                      <div className="bg-blue-600 h-full rounded"
                        style={{ width: `${(Number(t.taxable_value) / peak) * 100}%` }} />
                    </div>
                    <span className="w-24 text-right tabular-nums font-medium">
                      ₹ {short(Number(t.taxable_value))}
                    </span>
                    <span className="w-14 text-right text-slate-500">{t.invoices} inv</span>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="border border-slate-300 rounded-lg bg-white p-3">
            <h3 className="text-xs font-bold uppercase tracking-wide text-slate-600 mb-3 flex items-center gap-1">
              <Clock className="w-3.5 h-3.5" /> Who owes the most
            </h3>
            {data.topDebtors.length === 0 ? (
              <p className="text-xs text-slate-500">Every bill is settled.</p>
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-slate-500 border-b border-slate-200">
                    <th className="py-1">Party</th>
                    <th className="text-right">Bills</th>
                    <th className="text-right">Outstanding</th>
                    <th className="text-right">Overdue</th>
                  </tr>
                </thead>
                <tbody>
                  {data.topDebtors.map(d => (
                    <tr key={d.code} className="border-b border-slate-100 last:border-0">
                      <td className="py-1">{d.party}</td>
                      <td className="text-right tabular-nums">{d.bills}</td>
                      <td className="text-right tabular-nums">₹ {inr(Number(d.outstanding))}</td>
                      <td className={`text-right tabular-nums ${Number(d.overdue) > 0 ? 'text-red-700 font-semibold' : 'text-slate-400'}`}>
                        {Number(d.overdue) > 0
                          ? `₹ ${inr(Number(d.overdue))} · ${d.worst_overdue_days}d`
                          : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>

        {onOpen && (
          <div className="flex flex-wrap gap-2 mt-4 print:hidden">
            {[
              ['grey_inward', 'Grey Inward'],
              ['dyeing_issue', 'Issue to Dyeing'],
              ['dyeing_receipt', 'Dyeing Receipt'],
              ['dispatch', 'Dispatch'],
              ['sales_invoices', 'Tax Invoice'],
              ['payments', 'Receipt / Payment']
            ].map(([key, label]) => (
              <button key={key} onClick={() => onOpen(key!)} className="erp-btn erp-btn-primary">
                {label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
