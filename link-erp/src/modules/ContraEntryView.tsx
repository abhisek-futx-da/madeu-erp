import React, { useMemo, useState } from 'react';
import { ToolbarRibbon } from '../components/ToolbarRibbon';
import { useApi } from '../lib/useApi';
import { api } from '../lib/api';
import type { LedgerRow } from '../lib/api';
import { AlertTriangle, ArrowRightLeft, CheckCircle2 } from 'lucide-react';

/**
 * Money moving between the mill's own cash and bank accounts.
 *
 * Cash deposited, cash drawn for wages, a transfer between two banks. No party
 * is involved and nothing is bought or sold, so booking it as a receipt or a
 * payment puts an invented counterparty into somebody's ledger — which is what
 * everyone did before this screen existed.
 */
interface Entry {
  id: string; entry_no: string; entry_date: string;
  from_account: string; to_account: string; amount: number;
  instrument_no: string | null; narration: string; voucher_no: string | null;
}

const money = (n: unknown) =>
  `₹${Number(n ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
const today = () => new Date().toISOString().slice(0, 10);

export const ContraEntryView: React.FC = () => {
  const [entryDate, setEntryDate] = useState(today());
  const [fromLedgerId, setFrom] = useState('');
  const [toLedgerId, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [instrumentNo, setInstrument] = useState('');
  const [narration, setNarration] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const ledgers = useApi<LedgerRow[]>('/ledgers');
  const controls = useApi<{ id: string; nature: string }[]>('/control-accounts');
  const entries = useApi<{ rows: Entry[] }>('/contra-entries?limit=50');

  /** Only the mill's own money: the server refuses anything else anyway. */
  const ownMoney = useMemo(() => {
    const cashOrBank = new Set((controls.data ?? [])
      .filter(c => c.nature === 'cash' || c.nature === 'bank').map(c => c.id));
    return (ledgers.data ?? []).filter(l => cashOrBank.has(l.control_account_id));
  }, [ledgers.data, controls.data]);

  const value = Number(amount);
  const sameAccount = Boolean(fromLedgerId) && fromLedgerId === toLedgerId;
  const ready = Boolean(fromLedgerId && toLedgerId) && !sameAccount && value > 0 && !busy;

  const post = async () => {
    setBusy(true); setError(null); setDone(null);
    try {
      const out = await api.post<any>('/contra-entries', {
        entryDate, fromLedgerId, toLedgerId, amount: value,
        instrumentNo: instrumentNo.trim() || null, narration: narration.trim()
      });
      setDone(`${out.entryNo}: ${money(out.amount)} from ${out.from} to ${out.to}`);
      setAmount(''); setInstrument(''); setNarration('');
      entries.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const options = (exclude: string) => ownMoney
    .filter(l => l.id !== exclude)
    .map(l => <option key={l.id} value={l.id}>{l.code} — {l.name}</option>);

  return (
    <div className="flex h-full flex-col bg-[#ecf1f7] text-xs text-slate-800">
      <ToolbarRibbon title="Contra — the mill's own money moving"
        actions={[{ key: 'save', onRun: () => void post(), disabled: !ready }]} />

      <div className="border-b bg-blue-50 px-3 py-2 text-blue-950">
        <ArrowRightLeft className="mr-1 inline h-4 w-4" />
        Cash into the bank, cash drawn for wages, one bank to another. No party is
        involved, so this is neither a receipt nor a payment.
      </div>

      <div className="grid gap-2 border-b bg-white px-3 py-3 md:grid-cols-3 lg:grid-cols-6">
        <div>
          <label htmlFor="contra-date" className="erp-label block">Date</label>
          <input id="contra-date" type="date" className="erp-input min-h-11 w-full"
            value={entryDate} onChange={e => setEntryDate(e.target.value)} />
        </div>
        <div className="lg:col-span-2">
          <label htmlFor="contra-from" className="erp-label block font-bold text-red-700">* From</label>
          <select id="contra-from" className="erp-input min-h-11 w-full"
            value={fromLedgerId} onChange={e => setFrom(e.target.value)}>
            <option value="">Account money leaves</option>
            {options(toLedgerId)}
          </select>
        </div>
        <div className="lg:col-span-2">
          <label htmlFor="contra-to" className="erp-label block font-bold text-red-700">* To</label>
          <select id="contra-to" className="erp-input min-h-11 w-full"
            value={toLedgerId} onChange={e => setTo(e.target.value)}>
            <option value="">Account money reaches</option>
            {options(fromLedgerId)}
          </select>
        </div>
        <div>
          <label htmlFor="contra-amount" className="erp-label block font-bold text-red-700">* Amount</label>
          <input id="contra-amount" type="number" step="0.01" min="0"
            className="erp-input min-h-11 w-full text-right"
            value={amount} onChange={e => setAmount(e.target.value)} />
        </div>
        <div className="lg:col-span-2">
          <label htmlFor="contra-ref" className="erp-label block">Cheque / UTR</label>
          <input id="contra-ref" className="erp-input min-h-11 w-full"
            value={instrumentNo} onChange={e => setInstrument(e.target.value)} />
        </div>
        <div className="lg:col-span-4">
          <label htmlFor="contra-note" className="erp-label block">Narration</label>
          <input id="contra-note" className="erp-input min-h-11 w-full"
            value={narration} onChange={e => setNarration(e.target.value)} />
        </div>
      </div>

      {sameAccount && (
        <div role="alert" className="bg-amber-200 px-4 py-1.5 font-semibold text-amber-900">
          Money cannot move from an account to itself.
        </div>
      )}
      {error && (
        <div role="alert" className="bg-red-600 px-4 py-1.5 font-semibold text-white">
          <AlertTriangle className="mr-1 inline h-4 w-4" />{error}
        </div>
      )}
      {done && (
        <div role="status" className="bg-emerald-700 px-4 py-1.5 font-semibold text-white">
          <CheckCircle2 className="mr-1 inline h-4 w-4" />{done}
        </div>
      )}

      <div className="border-b bg-white px-3 py-2">
        <button className="erp-btn erp-btn-primary min-h-11" disabled={!ready}
          onClick={() => void post()}>
          {busy ? 'Posting…' : 'Post contra'}
        </button>
      </div>

      <div className="flex-1 overflow-auto p-3">
        <table className="w-full border border-[#b8c9dd] bg-white">
          <thead className="border-b border-slate-300 bg-slate-100">
            <tr>
              <th className="px-2 py-1.5 text-left font-bold">Date</th>
              <th className="px-2 py-1.5 text-left font-bold">Entry</th>
              <th className="px-2 py-1.5 text-left font-bold">From</th>
              <th className="px-2 py-1.5 text-left font-bold">To</th>
              <th className="px-2 py-1.5 text-right font-bold">Amount</th>
              <th className="px-2 py-1.5 text-left font-bold">Reference</th>
              <th className="px-2 py-1.5 text-left font-bold">Narration</th>
              <th className="px-2 py-1.5 text-left font-bold">Voucher</th>
            </tr>
          </thead>
          <tbody>
            {(entries.data?.rows ?? []).length === 0 && (
              <tr><td colSpan={8} className="px-2 py-8 text-center text-slate-600">
                No transfers recorded yet.
              </td></tr>
            )}
            {(entries.data?.rows ?? []).map(row => (
              <tr key={row.id} className="border-b border-slate-100 hover:bg-blue-50/40">
                <td className="px-2 py-1">{row.entry_date}</td>
                <td className="px-2 py-1 font-mono">{row.entry_no}</td>
                <td className="px-2 py-1">{row.from_account}</td>
                <td className="px-2 py-1">{row.to_account}</td>
                <td className="px-2 py-1 text-right font-mono">{money(row.amount)}</td>
                <td className="px-2 py-1">{row.instrument_no ?? ''}</td>
                <td className="px-2 py-1">{row.narration}</td>
                <td className="px-2 py-1 font-mono">{row.voucher_no ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};
