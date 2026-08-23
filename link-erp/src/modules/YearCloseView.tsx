import React, { useState } from 'react';
import { ToolbarRibbon } from '../components/ToolbarRibbon';
import { useApi } from '../lib/useApi';
import { api, ApiError } from '../lib/api';
import { AlertTriangle, CheckCircle2, Lock, Unlock } from 'lucide-react';

interface YearRow {
  label: string; starts_on: string; ends_on: string;
  status: 'open' | 'pending' | 'closing' | 'closed'; closed_at: string | null;
}

interface TrialRow { balance: number }

const money = (v: number) => `₹${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
const nextLabelFor = (label: string) => {
  const [start] = label.split('-');
  const y = Number(start) + 1;
  return `${y}-${String(y + 1).slice(2)}`;
};

/**
 * Year end. Closing proves the books balance, carries balance sheet accounts
 * forward and locks the year; reopening is possible but is the owner's call.
 */
export const YearCloseView: React.FC = () => {
  const years = useApi<YearRow[]>('/financial-years');
  const trial = useApi<TrialRow[]>('/reports/trial-balance');
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const drift = (trial.data ?? []).reduce((n, r) => n + Number(r.balance), 0);
  const balanced = Math.abs(drift) < 0.01;

  const act = async (label: string, action: 'close' | 'reopen') => {
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      const out = await api.post<any>(`/financial-years/${label}/${action}`, {
        nextLabel: nextLabelFor(label)
      });
      setNotice(
        action === 'close'
          ? `${label} closed — ${out.ledgersCarried} ledgers carried into ${out.nextFy}, ` +
            `${money(out.totalDebit)} debit against ${money(out.totalCredit)} credit`
          : `${label} reopened; carried balances cleared`
      );
      years.reload();
      trial.reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col h-full bg-[#ecf1f7] text-slate-800 text-xs">
      <ToolbarRibbon title="Year End Close" onPrint={() => window.print()} />

      {(notice || error) && (
        <div className={`px-4 py-1.5 flex items-center gap-2 font-semibold ${
          error ? 'bg-red-600 text-white' : 'bg-emerald-600 text-white'
        }`}>
          {error ? <AlertTriangle className="w-4 h-4" /> : <CheckCircle2 className="w-4 h-4" />}
          <span>{error ?? notice}</span>
        </div>
      )}

      <div className="flex-1 overflow-auto p-3 space-y-3">
        <div className={`rounded border p-3 ${
          balanced
            ? 'bg-emerald-50 border-emerald-300 text-emerald-900'
            : 'bg-red-50 border-red-300 text-red-900'
        }`}>
          <p className="font-bold">
            {balanced
              ? 'The trial balance is square. A year may be closed.'
              : `The trial balance is out by ${money(drift)}. Closing will be refused.`}
          </p>
          <p className="mt-0.5">
            Closing carries every balance sheet account into the next year and transfers the
            profit or loss to retained earnings. Nothing can be posted into a closed year.
          </p>
        </div>

        <div className="bg-white rounded border border-[#b8c9dd] overflow-hidden">
          <table className="w-full">
            <thead className="bg-slate-100 border-b border-slate-300 text-left">
              <tr>
                <th className="px-2 py-1.5 font-bold">Financial Year</th>
                <th className="px-2 py-1.5 font-bold">From</th>
                <th className="px-2 py-1.5 font-bold">To</th>
                <th className="px-2 py-1.5 font-bold">Status</th>
                <th className="px-2 py-1.5 font-bold">Closed On</th>
                <th className="px-2 py-1.5"></th>
              </tr>
            </thead>
            <tbody>
              {(years.data ?? []).map(y => (
                <tr key={y.label} className="border-b border-slate-100">
                  <td className="px-2 py-1 font-mono font-bold text-blue-800">{y.label}</td>
                  <td className="px-2 py-1">{y.starts_on}</td>
                  <td className="px-2 py-1">{y.ends_on}</td>
                  <td className="px-2 py-1">
                    <span className={`px-1.5 py-0.5 rounded border font-semibold inline-flex items-center gap-1 ${
                      y.status === 'closed'
                        ? 'bg-slate-100 border-slate-300 text-slate-700'
                        : 'bg-emerald-50 border-emerald-300 text-emerald-800'
                    }`}>
                      {y.status === 'closed' ? <Lock className="w-3 h-3" /> : <Unlock className="w-3 h-3" />}
                      {y.status}
                    </span>
                  </td>
                  <td className="px-2 py-1">
                    {y.closed_at ? new Date(y.closed_at).toLocaleDateString('en-GB') : ''}
                  </td>
                  <td className="px-2 py-1 text-right">
                    {y.status === 'open' ? (
                      <button
                        onClick={() => act(y.label, 'close')}
                        disabled={busy === y.label || !balanced}
                        title={balanced ? `Close ${y.label}` : 'the trial balance must be square first'}
                        className="erp-btn erp-btn-primary font-bold disabled:opacity-50"
                      >
                        {busy === y.label ? 'Closing…' : `Close ${y.label}`}
                      </button>
                    ) : y.status === 'closed' ? (
                      <button
                        onClick={() => act(y.label, 'reopen')}
                        disabled={busy === y.label}
                        className="erp-btn disabled:opacity-50"
                      >
                        {busy === y.label ? 'Reopening…' : 'Reopen'}
                      </button>
                    ) : <span className="text-slate-500">Awaiting prior-year close</span>}
                  </td>
                </tr>
              ))}
              {!years.loading && (years.data ?? []).length === 0 && (
                <tr><td colSpan={6} className="px-2 py-5 text-center text-slate-400">
                  No financial years configured
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
