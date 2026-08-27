import React, { useMemo, useState } from 'react';
import { ToolbarRibbon } from '../components/ToolbarRibbon';
import { useApi } from '../lib/useApi';
import { api } from '../lib/api';
import { BookOpen } from 'lucide-react';

/**
 * One account over one period, opening balance first. The party statement
 * report carries a running balance over all time and cannot be windowed —
 * cut it to a date range and the balance starts from nowhere, which is the
 * one thing a ledger must never do.
 */
interface Ledger { id: string; name: string; code: string }
interface Row {
  seq: number; voucher_date: string; voucher_type: string; voucher_no: string;
  narration: string; debit: number; credit: number; running_balance: number;
}
interface Statement {
  ledger: { code: string; name: string };
  from: string; to: string; opening: number; closing: number;
  totals: { debit: number; credit: number };
  rows: Row[];
}

const money = (v: unknown) =>
  v == null ? '' : Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2 });

/** Dr and Cr, the way an Indian ledger is read. */
const sided = (amount: number) =>
  `${money(Math.abs(amount))} ${amount < 0 ? 'Cr' : 'Dr'}`;

function financialYearStart(): string {
  const now = new Date();
  const year = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  return `${year}-04-01`;
}

export const LedgerView: React.FC = () => {
  const [ledgerId, setLedgerId] = useState('');
  const [from, setFrom] = useState(financialYearStart);
  const [to, setTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [message, setMessage] = useState('');

  const ledgers = useApi<Ledger[]>('/ledgers');
  const ready = Boolean(ledgerId) && to >= from;
  const query = useMemo(
    () => `/ledger?ledgerId=${ledgerId}&from=${from}&to=${to}`, [ledgerId, from, to]);
  const { data, error, loading } = useApi<Statement>(ready ? query : null);

  const take = async (format: 'csv' | 'pdf') => {
    if (!ready) return;
    setMessage(`Preparing the ${format.toUpperCase()}…`);
    try {
      await api.download(`${query}&format=${format}`, `ledger-${from}-to-${to}`);
      setMessage(`${format.toUpperCase()} downloaded`);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'the export failed');
    }
  };

  const rows = data?.rows ?? [];

  return (
    <div className="flex h-full flex-col bg-[#ecf1f7] text-xs text-slate-800">
      <ToolbarRibbon title="Ledger — one account, one period"
        onPrint={() => void take('pdf')} onExport={() => void take('csv')} />

      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-3 py-2">
        <BookOpen className="h-4 w-4 text-blue-700" />
        {/* Wrapping a select in its label makes every option part of the
            control's accessible name; these are associated by id instead. */}
        <label htmlFor="ledger-account">Account</label>
        <select id="ledger-account" className="erp-input min-h-11 min-w-64"
          value={ledgerId} onChange={e => setLedgerId(e.target.value)}>
          <option value="">Choose an account</option>
          {(ledgers.data ?? []).map(l => (
            <option key={l.id} value={l.id}>{l.code} — {l.name}</option>
          ))}
        </select>
        <label htmlFor="ledger-from">From date</label>
        <input id="ledger-from" type="date" className="erp-input min-h-11"
          value={from} onChange={e => setFrom(e.target.value)} />
        <label htmlFor="ledger-to">To date</label>
        <input id="ledger-to" type="date" className="erp-input min-h-11"
          value={to} onChange={e => setTo(e.target.value)} />
        {to < from && (
          <span role="alert" className="font-semibold text-red-700">
            The closing date falls before the opening date.
          </span>
        )}
        {message && <span role="status" className="font-semibold text-emerald-800">{message}</span>}
      </div>

      {error && <div className="bg-red-600 px-4 py-1.5 font-semibold text-white">{error}</div>}

      {data && (
        <div className="grid grid-cols-2 gap-2 border-b bg-blue-50 px-3 py-2 sm:grid-cols-4">
          <div><span className="text-slate-600">Opening</span>
            <p className="font-mono font-bold">{sided(data.opening)}</p></div>
          <div><span className="text-slate-600">Debits</span>
            <p className="font-mono font-bold">{money(data.totals.debit)}</p></div>
          <div><span className="text-slate-600">Credits</span>
            <p className="font-mono font-bold">{money(data.totals.credit)}</p></div>
          <div><span className="text-slate-600">Closing</span>
            <p className="font-mono font-bold text-blue-900">{sided(data.closing)}</p></div>
        </div>
      )}

      <div className="flex-1 overflow-auto p-3">
        {!ledgerId ? (
          <p className="p-8 text-center text-slate-600">
            Choose an account to see its ledger for the period.
          </p>
        ) : (
          <table className="w-full border border-[#b8c9dd] bg-white">
            <thead className="sticky top-0 border-b border-slate-300 bg-slate-100">
              <tr>
                <th className="px-2 py-1.5 text-left font-bold">Date</th>
                <th className="px-2 py-1.5 text-left font-bold">Particulars</th>
                <th className="px-2 py-1.5 text-left font-bold">Type</th>
                <th className="px-2 py-1.5 text-left font-bold">Voucher</th>
                <th className="px-2 py-1.5 text-right font-bold">Debit</th>
                <th className="px-2 py-1.5 text-right font-bold">Credit</th>
                <th className="px-2 py-1.5 text-right font-bold">Balance</th>
              </tr>
            </thead>
            <tbody>
              {!loading && rows.length === 0 && (
                <tr><td colSpan={7} className="px-2 py-8 text-center text-slate-600">
                  Nothing was posted to this account in that period.
                </td></tr>
              )}
              {rows.map(row => (
                <tr key={row.seq}
                    className={row.seq === 0
                      ? 'border-b bg-slate-50 font-semibold'
                      : 'border-b border-slate-100 hover:bg-blue-50/40'}>
                  <td className="px-2 py-1">{row.voucher_date}</td>
                  <td className="px-2 py-1">{row.narration}</td>
                  <td className="px-2 py-1">{row.voucher_type}</td>
                  <td className="px-2 py-1">{row.voucher_no}</td>
                  <td className="px-2 py-1 text-right font-mono">
                    {Number(row.debit) ? money(row.debit) : ''}</td>
                  <td className="px-2 py-1 text-right font-mono">
                    {Number(row.credit) ? money(row.credit) : ''}</td>
                  <td className="px-2 py-1 text-right font-mono">{sided(Number(row.running_balance))}</td>
                </tr>
              ))}
            </tbody>
            {data && rows.length > 0 && (
              <tfoot className="sticky bottom-0 border-t-2 border-slate-400 bg-slate-100 font-bold">
                <tr>
                  <td className="px-2 py-1.5" colSpan={4}>Period total</td>
                  <td className="px-2 py-1.5 text-right font-mono">{money(data.totals.debit)}</td>
                  <td className="px-2 py-1.5 text-right font-mono">{money(data.totals.credit)}</td>
                  <td className="px-2 py-1.5 text-right font-mono text-blue-900">{sided(data.closing)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        )}
      </div>
    </div>
  );
};
