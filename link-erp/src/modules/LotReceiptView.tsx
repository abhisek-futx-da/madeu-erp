import React, { useMemo, useState } from 'react';
import { ToolbarRibbon } from '../components/ToolbarRibbon';
import { useApi } from '../lib/useApi';
import { api } from '../lib/api';
import type { LedgerRow } from '../lib/api';
import { AlertTriangle, CheckCircle2, Layers, Plus, Trash2 } from 'lucide-react';

/**
 * Receiving from a process house that cannot return the barcodes it was sent.
 *
 * The piece-wise screen needs every grey barcode back. Where thaans are
 * stitched into one batch for the machine and cut into different lengths at
 * the inspection table, none of them come back — so the mill agrees the
 * quantity against the challan it sent and barcodes what actually arrived.
 */
interface Outstanding {
  issue_id: string; entry_no: string; entry_date: string; challan_no: string;
  lot_no: string; process_house: string; process_house_id: string;
  thaans: number; issued_qty: number; days_out: number;
}
interface NewPiece { barcode: string; qty: string; finishGrade: string; rackCode: string }

const today = () => new Date().toISOString().slice(0, 10);
const blank = (): NewPiece => ({ barcode: '', qty: '', finishGrade: 'A', rackCode: '' });

export const LotReceiptView: React.FC = () => {
  const [issueId, setIssueId] = useState('');
  const [challanNo, setChallanNo] = useState('');
  const [challanDate, setChallanDate] = useState(today());
  const [entryDate, setEntryDate] = useState(today());
  const [jobRate, setJobRate] = useState('18');
  const [pieces, setPieces] = useState<NewPiece[]>([blank()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const ledgers = useApi<LedgerRow[]>('/ledgers');
  const outstanding = useApi<Outstanding[]>('/dyeing-issues/outstanding');
  const chosen = (outstanding.data ?? []).find(o => o.issue_id === issueId);

  const received = useMemo(
    () => pieces.reduce((n, p) => n + (Number(p.qty) || 0), 0), [pieces]);
  const issued = Number(chosen?.issued_qty ?? 0);
  const shrinkage = issued > 0 ? ((issued - received) * 100) / issued : 0;

  const named = pieces.filter(p => p.barcode.trim() && Number(p.qty) > 0);
  const duplicated = new Set(named.map(p => p.barcode.trim())).size !== named.length;
  const ready = Boolean(issueId && challanNo.trim()) && named.length > 0 && !duplicated;

  const update = (i: number, patch: Partial<NewPiece>) =>
    setPieces(current => current.map((p, at) => (at === i ? { ...p, ...patch } : p)));

  const post = async () => {
    setBusy(true); setError(null); setDone(null);
    try {
      const out = await api.post<any>('/dyeing-receipts/by-lot', {
        issueId, entryDate, challanNo: challanNo.trim(), challanDate,
        jobRate: Number(jobRate) || 0,
        pieces: named.map(p => ({
          barcode: p.barcode.trim(), qty: Number(p.qty),
          finishGrade: p.finishGrade, rackCode: p.rackCode.trim() || null
        }))
      });
      setDone(
        `${out.entryNo}: ${out.thaansSent} thaan sent, ${out.thaansReturned} back — ` +
        `${out.receivedQty} of ${out.issuedQty} mtr, ${out.shrinkagePct}% shrinkage`);
      setPieces([blank()]); setChallanNo(''); setIssueId('');
      outstanding.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full flex-col bg-[#ecf1f7] text-xs text-slate-800">
      <ToolbarRibbon title="Receive By Lot — when the barcodes did not come back"
        actions={[{ key: 'save', onRun: () => void post(), disabled: !ready || busy }]} />

      <div className="border-b bg-amber-50 px-3 py-2 text-amber-900">
        <Layers className="mr-1 inline h-4 w-4" />
        For a process house that returns cloth in different pieces than it was sent.
        The thaans you sent are closed off and the lengths below are barcoded fresh.
        If every barcode came back, use <strong>Receive From Dyeing</strong> instead.
      </div>

      <div className="grid gap-2 border-b bg-white px-3 py-2 md:grid-cols-2 lg:grid-cols-4">
        <div className="lg:col-span-2">
          <label htmlFor="lot-issue" className="erp-label block font-bold text-red-700">* Against challan</label>
          <select id="lot-issue" className="erp-input min-h-11 w-full"
            value={issueId} onChange={e => setIssueId(e.target.value)}>
            <option value="">Choose what is still out</option>
            {(outstanding.data ?? []).map(o => (
              <option key={o.issue_id} value={o.issue_id}>
                {o.challan_no} — {o.process_house} — {o.thaans} thaan, {o.issued_qty} mtr
                {o.days_out > 0 ? ` (${o.days_out} d out)` : ''}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="lot-challan" className="erp-label block font-bold text-red-700">* Their challan no.</label>
          <input id="lot-challan" className="erp-input min-h-11 w-full"
            value={challanNo} onChange={e => setChallanNo(e.target.value)} />
        </div>
        <div>
          <label htmlFor="lot-challan-date" className="erp-label block">Their challan date</label>
          <input id="lot-challan-date" type="date" className="erp-input min-h-11 w-full"
            value={challanDate} onChange={e => setChallanDate(e.target.value)} />
        </div>
        <div>
          <label htmlFor="lot-entry-date" className="erp-label block">Entry date</label>
          <input id="lot-entry-date" type="date" className="erp-input min-h-11 w-full"
            value={entryDate} onChange={e => setEntryDate(e.target.value)} />
        </div>
        <div>
          <label htmlFor="lot-rate" className="erp-label block">Job rate ₹/mtr</label>
          <input id="lot-rate" type="number" step="0.01" className="erp-input min-h-11 w-full"
            value={jobRate} onChange={e => setJobRate(e.target.value)} />
        </div>
      </div>

      {chosen && (
        <div className="grid grid-cols-2 gap-2 border-b bg-blue-50 px-3 py-2 sm:grid-cols-4">
          <div><span className="text-slate-600">Sent</span>
            <p className="font-mono font-bold">{chosen.thaans} thaan · {issued} mtr</p></div>
          <div><span className="text-slate-600">Back</span>
            <p className="font-mono font-bold">{named.length} thaan · {received.toFixed(2)} mtr</p></div>
          <div><span className="text-slate-600">Shrinkage</span>
            <p className={`font-mono font-bold ${shrinkage > 12 ? 'text-red-700' : ''}`}>
              {(issued - received).toFixed(2)} mtr · {shrinkage.toFixed(2)}%</p></div>
          <div><span className="text-slate-600">Job work</span>
            <p className="font-mono font-bold">
              ₹{(received * (Number(jobRate) || 0)).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</p></div>
        </div>
      )}

      {error && (
        <div className="bg-red-600 px-4 py-1.5 font-semibold text-white" role="alert">
          <AlertTriangle className="mr-1 inline h-4 w-4" />{error}
        </div>
      )}
      {done && (
        <div className="bg-emerald-700 px-4 py-1.5 font-semibold text-white" role="status">
          <CheckCircle2 className="mr-1 inline h-4 w-4" />{done}
        </div>
      )}
      {duplicated && (
        <div className="bg-amber-200 px-4 py-1.5 font-semibold text-amber-900" role="alert">
          Two thaans have been given the same barcode.
        </div>
      )}

      <div className="flex-1 overflow-auto p-3">
        <table className="w-full border border-[#b8c9dd] bg-white">
          <thead className="border-b border-slate-300 bg-slate-100">
            <tr>
              <th className="px-2 py-1.5 text-left font-bold">New barcode</th>
              <th className="px-2 py-1.5 text-right font-bold">Metres</th>
              <th className="px-2 py-1.5 text-left font-bold">Grade</th>
              <th className="px-2 py-1.5 text-left font-bold">Rack</th>
              <th className="px-2 py-1.5" />
            </tr>
          </thead>
          <tbody>
            {pieces.map((p, i) => (
              <tr key={i} className="border-b border-slate-100">
                <td className="px-2 py-1">
                  <input aria-label={`Barcode ${i + 1}`} className="erp-input min-h-11 w-full font-mono"
                    value={p.barcode} onChange={e => update(i, { barcode: e.target.value })} />
                </td>
                <td className="px-2 py-1">
                  <input aria-label={`Metres ${i + 1}`} type="number" step="0.01"
                    className="erp-input min-h-11 w-28 text-right"
                    value={p.qty} onChange={e => update(i, { qty: e.target.value })} />
                </td>
                <td className="px-2 py-1">
                  <input aria-label={`Grade ${i + 1}`} className="erp-input min-h-11 w-24"
                    value={p.finishGrade} onChange={e => update(i, { finishGrade: e.target.value })} />
                </td>
                <td className="px-2 py-1">
                  <input aria-label={`Rack ${i + 1}`} className="erp-input min-h-11 w-24"
                    value={p.rackCode} onChange={e => update(i, { rackCode: e.target.value })} />
                </td>
                <td className="px-2 py-1">
                  <button className="erp-btn min-h-11" aria-label={`Remove thaan ${i + 1}`}
                    disabled={pieces.length === 1}
                    onClick={() => setPieces(c => c.filter((_, at) => at !== i))}>
                    <Trash2 className="h-4 w-4 text-red-700" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <button className="erp-btn min-h-11 mt-2" onClick={() => setPieces(c => [...c, blank()])}>
          <Plus className="h-4 w-4" />Add thaan
        </button>

        <div className="mt-4">
          <button className="erp-btn erp-btn-primary min-h-11" disabled={!ready || busy}
            onClick={() => void post()}>
            {busy ? 'Posting…' : 'Post lot receipt'}
          </button>
          {!ledgers.data && <span className="ml-2 text-slate-600">Loading masters…</span>}
        </div>
      </div>
    </div>
  );
};
