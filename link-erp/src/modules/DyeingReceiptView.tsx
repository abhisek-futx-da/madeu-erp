import React, { useMemo, useState } from 'react';
import { ToolbarRibbon } from '../components/ToolbarRibbon';
import { useApi } from '../lib/useApi';
import { api } from '../lib/api';
import { enqueue, isOnline } from '../lib/offlineQueue';
import type { LedgerRow, PieceRow } from '../lib/api';
import { ArrowDownToLine, AlertTriangle, CheckCircle2, Trash2 } from 'lucide-react';

interface Line {
  barcode: string;
  quality: string;
  issuedQty: number;
  receivedQty: number;
  finishGrade: string;
  jobRate: number;
}

const today = () => new Date().toISOString().slice(0, 10);

/**
 * The return leg from the process house. Shrinkage is grey issued minus finish
 * received; a mill watches this number more closely than almost anything else.
 */
export const DyeingReceiptView: React.FC = () => {
  const [processHouseId, setProcessHouseId] = useState('');
  const [challanNo, setChallanNo] = useState('');
  const [challanDate, setChallanDate] = useState(today());
  const [entryDate, setEntryDate] = useState(today());
  const [defaultRate, setDefaultRate] = useState(18);
  const [lines, setLines] = useState<Line[]>([]);
  const [scan, setScan] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  const ledgers = useApi<LedgerRow[]>('/ledgers');
  const outAtHouse = useApi<PieceRow[]>('/pieces?status=issued_to_dyeing&limit=100000');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const processHouses = useMemo(
    () => (outAtHouse.data ?? []).reduce<Record<string, string>>((acc, p) => {
      if (p.held_by) acc[p.held_by] = p.held_by;
      return acc;
    }, {}),
    [outAtHouse.data]
  );

  const totals = lines.reduce(
    (a, l) => ({
      issued: a.issued + l.issuedQty,
      received: a.received + l.receivedQty,
      jobwork: a.jobwork + l.receivedQty * l.jobRate
    }),
    { issued: 0, received: 0, jobwork: 0 }
  );
  const shrinkagePct = totals.issued > 0
    ? ((totals.issued - totals.received) * 100) / totals.issued
    : 0;

  const addByBarcode = (e: React.FormEvent) => {
    e.preventDefault();
    const code = scan.trim();
    if (!code) return;
    setScan('');

    if (lines.some(l => l.barcode === code)) {
      setNotice(`${code} is already on this receipt`);
      return;
    }
    const piece = (outAtHouse.data ?? []).find(p => p.barcode === code);
    if (!piece) {
      setNotice(`${code} is not currently out at any process house`);
      return;
    }
    setNotice(null);
    setLines(prev => [...prev, {
      barcode: piece.barcode,
      quality: piece.quality,
      issuedQty: piece.current_qty,
      receivedQty: piece.current_qty,
      finishGrade: 'A',
      jobRate: defaultRate
    }]);
  };

  const update = (idx: number, patch: Partial<Line>) =>
    setLines(prev => prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)));

  const save = async () => {
    if (!processHouseId || lines.length === 0) {
      setNotice('pick a process house and scan at least one piece');
      return;
    }
    const body = {
      processHouseId, entryDate, challanNo, challanDate,
      lines: lines.map(l => ({
        barcode: l.barcode, receivedQty: l.receivedQty,
        finishGrade: l.finishGrade, jobRate: l.jobRate
      }))
    };

    if (!isOnline()) {
      await enqueue('/dyeing-receipts', body);
      setNotice(`No network — ${lines.length} piece(s) queued to post when signal returns`);
      setLines([]);
      setChallanNo('');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const out = await api.post<any>('/dyeing-receipts', body);
      setNotice(`Receipt ${out.entryNo} posted — ${out.pieces} pcs, ${out.shrinkagePct.toFixed(1)}% shrinkage, ₹${out.jobwork.toLocaleString('en-IN')} jobwork`);
      setLines([]);
      setChallanNo('');
      outAtHouse.reload();
    } catch (e: any) {
      if (e.message === 'Failed to fetch' || e.message === 'NetworkError') {
        await enqueue('/dyeing-receipts', body);
        setNotice(`Connection dropped — ${lines.length} piece(s) queued to sync in background`);
        setLines([]);
        setChallanNo('');
      } else {
        setError(e.message || String(e));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col h-full bg-[#ecf1f7] text-slate-800 text-xs">
      <ToolbarRibbon
        title="Receive From Dyeing"
        onSave={save}
        onNew={() => { setLines([]); setChallanNo(''); setNotice(null); }}
        onPrint={() => window.print()}
      />

      {(notice || error) && (
        <div className={`px-4 py-1.5 flex items-center gap-2 font-semibold ${
          error ? 'bg-red-600 text-white' : 'bg-emerald-600 text-white'
        }`}>
          {error ? <AlertTriangle className="w-4 h-4" /> : <CheckCircle2 className="w-4 h-4" />}
          <span>{error ?? notice}</span>
        </div>
      )}

      <div className="p-3 flex-1 overflow-y-auto max-w-7xl mx-auto w-full space-y-3">
        <div className="bg-white rounded border border-[#b8c9dd] p-3 shadow-2xs">
          <div className="grid grid-cols-1 md:grid-cols-12 gap-2.5">
            <div className="md:col-span-4">
              <label className="erp-label block text-red-700 font-bold">* Process House</label>
              <select
                value={processHouseId}
                onChange={e => setProcessHouseId(e.target.value)}
                className="erp-input w-full"
              >
                <option value="">— select —</option>
                {(ledgers.data ?? [])
                  .filter(l => Object.hasOwn(processHouses, l.name))
                  .map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </div>
            <div className="md:col-span-2">
              <label className="erp-label block text-red-700 font-bold">* Their Challan</label>
              <input value={challanNo} onChange={e => setChallanNo(e.target.value)}
                     className="erp-input w-full font-mono" />
            </div>
            <div className="md:col-span-2">
              <label className="erp-label block">Challan Date</label>
              <input type="date" value={challanDate} onChange={e => setChallanDate(e.target.value)}
                     className="erp-input w-full" />
            </div>
            <div className="md:col-span-2">
              <label className="erp-label block">Entry Date</label>
              <input type="date" value={entryDate} onChange={e => setEntryDate(e.target.value)}
                     className="erp-input w-full" />
            </div>
            <div className="md:col-span-2">
              <label className="erp-label block">Job Rate ₹/mtr</label>
              <input type="number" step="0.01" value={defaultRate}
                     onChange={e => setDefaultRate(Number(e.target.value))}
                     className="erp-input w-full font-mono" />
            </div>
          </div>
        </div>

        <form onSubmit={addByBarcode} className="bg-white rounded border border-[#b8c9dd] p-3 flex items-center gap-2">
          <ArrowDownToLine className="w-4 h-4 text-blue-700" />
          <label className="font-bold text-blue-900" htmlFor="scan">Scan piece barcode</label>
          <input
            id="scan" autoFocus value={scan} onChange={e => setScan(e.target.value)}
            placeholder="scan or type, then Enter"
            className="erp-input font-mono w-64"
          />
          <span className="text-slate-500">
            {(outAtHouse.data ?? []).length} pieces currently out at process houses
          </span>
        </form>

        <div className="bg-white rounded border border-[#b8c9dd] overflow-hidden">
          <table className="w-full">
            <thead className="bg-slate-100 border-b border-slate-300 text-left">
              <tr>
                <th className="px-2 py-1.5 font-bold">Sno</th>
                <th className="px-2 py-1.5 font-bold">Barcode</th>
                <th className="px-2 py-1.5 font-bold">Quality</th>
                <th className="px-2 py-1.5 font-bold text-right">Issued</th>
                <th className="px-2 py-1.5 font-bold text-right">Received</th>
                <th className="px-2 py-1.5 font-bold text-right">Shrink %</th>
                <th className="px-2 py-1.5 font-bold">Grade</th>
                <th className="px-2 py-1.5 font-bold text-right">Rate</th>
                <th className="px-2 py-1.5 font-bold text-right">Jobwork</th>
                <th className="px-2 py-1.5"></th>
              </tr>
            </thead>
            <tbody>
              {lines.length === 0 && (
                <tr><td colSpan={10} className="px-2 py-6 text-center text-slate-400">
                  Scan a barcode to begin
                </td></tr>
              )}
              {lines.map((l, i) => {
                const pct = l.issuedQty > 0
                  ? ((l.issuedQty - l.receivedQty) * 100) / l.issuedQty : 0;
                const hot = pct > 8 || pct < 0;
                return (
                  <tr key={l.barcode} className="border-b border-slate-100">
                    <td className="px-2 py-1">{i + 1}</td>
                    <td className="px-2 py-1 font-mono text-blue-800">{l.barcode}</td>
                    <td className="px-2 py-1">{l.quality}</td>
                    <td className="px-2 py-1 text-right font-mono">{l.issuedQty.toFixed(2)}</td>
                    <td className="px-2 py-1 text-right">
                      <input
                        type="number" step="0.01" value={l.receivedQty}
                        onChange={e => update(i, { receivedQty: Number(e.target.value) })}
                        className="erp-input w-24 text-right font-mono"
                      />
                    </td>
                    <td className={`px-2 py-1 text-right font-mono font-bold ${
                      hot ? 'text-red-700' : 'text-slate-700'
                    }`}>
                      {pct.toFixed(2)}%
                    </td>
                    <td className="px-2 py-1">
                      <select value={l.finishGrade}
                              onChange={e => update(i, { finishGrade: e.target.value })}
                              className="erp-input w-24">
                        <option value="A">A</option>
                        <option value="B">B</option>
                        <option value="FRESH">Fresh</option>
                        <option value="SECONDS">Seconds</option>
                      </select>
                    </td>
                    <td className="px-2 py-1 text-right">
                      <input type="number" step="0.01" value={l.jobRate}
                             onChange={e => update(i, { jobRate: Number(e.target.value) })}
                             className="erp-input w-20 text-right font-mono" />
                    </td>
                    <td className="px-2 py-1 text-right font-mono">
                      ₹{(l.receivedQty * l.jobRate).toFixed(2)}
                    </td>
                    <td className="px-2 py-1 text-right">
                      <button onClick={() => setLines(prev => prev.filter((_, j) => j !== i))}
                              title="Remove line" className="text-red-600 hover:text-red-800">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <div className="bg-slate-50 border-t border-slate-300 px-3 py-2 flex items-center justify-end gap-6 font-bold">
            <span>Pieces: {lines.length}</span>
            <span>Issued: {totals.issued.toFixed(2)}</span>
            <span>Received: {totals.received.toFixed(2)}</span>
            <span className={shrinkagePct > 8 ? 'text-red-700' : 'text-emerald-800'}>
              Shrinkage: {shrinkagePct.toFixed(2)}%
            </span>
            <span>Jobwork: ₹{totals.jobwork.toFixed(2)}</span>
            <button onClick={save} disabled={busy}
                    className="erp-btn erp-btn-primary font-bold disabled:opacity-60">
              {busy ? 'Posting…' : 'Post Receipt'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
