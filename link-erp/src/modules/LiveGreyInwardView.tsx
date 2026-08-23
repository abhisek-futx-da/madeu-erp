import React, { useRef, useState } from 'react';
import { ToolbarRibbon } from '../components/ToolbarRibbon';
import { useApi } from '../lib/useApi';
import { api } from '../lib/api';
import { enqueue, isOnline } from '../lib/offlineQueue';
import type { GradeRow, LedgerRow, QualityRow } from '../lib/api';
import { Plus, Trash2, AlertTriangle, CheckCircle2, Barcode } from 'lucide-react';
import { captureScaleKg } from '../lib/hardware';

interface Line {
  barcode: string;
  qualityId: string;
  gradeCode: string;
  receivedQty: number;
  checkedQty: number;
  rate: number;
  rateUom: 'MTR' | 'KGS';
  grossWeightKg: number | null;
  tareWeightKg: number | null;
  netWeightKg: number | null;
}

const today = () => new Date().toISOString().slice(0, 10);

/** Grey arriving from the weaver. This is where a piece gets its barcode. */
export const LiveGreyInwardView: React.FC = () => {
  const [partyId, setPartyId] = useState('');
  const [challanNo, setChallanNo] = useState('');
  const [challanDate, setChallanDate] = useState(today());
  const [lotNo, setLotNo] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [scanCode, setScanCode] = useState('');
  const scanRef = useRef<HTMLInputElement>(null);

  const ledgers = useApi<LedgerRow[]>('/ledgers');
  const qualities = useApi<QualityRow[]>('/qualities');
  const grades = useApi<GradeRow[]>('/grades');
  const controls = useApi<{ id: string; nature: string }[]>('/control-accounts');

  const greyControlIds = new Set(
    (controls.data ?? []).filter(c => c.nature === 'sundry_creditor_grey').map(c => c.id)
  );
  const weavers = (ledgers.data ?? []).filter(l => greyControlIds.has(l.control_account_id));

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const addRow = (scannedBarcode?: string) => {
    const q = qualities.data?.[0];
    const g = grades.data?.[0];
    if (!q || !g) {
      setNotice('masters are still loading');
      return;
    }
    // Provisional barcode; the mill's own scanner value replaces it before saving.
    const seq = String(lines.length + 1).padStart(3, '0');
    setLines(prev => [...prev, {
      barcode: scannedBarcode?.trim() || `${Date.now().toString().slice(-8)}${seq}`,
      qualityId: q.id, gradeCode: g.code,
      receivedQty: 100, checkedQty: 100, rate: 30.5,
      rateUom: 'MTR',
      grossWeightKg: null, tareWeightKg: null, netWeightKg: null
    }]);
  };

  const addScanned = (event: React.FormEvent) => {
    event.preventDefault();
    const code = scanCode.trim();
    if (!code) return;
    if (lines.some(line => line.barcode === code)) {
      setNotice(`${code} is already on this inward`);
      setScanCode('');
      return;
    }
    addRow(code);
    setScanCode('');
    window.setTimeout(() => scanRef.current?.focus(), 0);
  };

  const readWeight = async (index: number) => {
    try {
      const gross = await captureScaleKg();
      const tare = lines[index]?.tareWeightKg ?? 0;
      update(index, { grossWeightKg: gross, netWeightKg: Math.max(0, gross - tare) });
      setNotice(`Scale captured ${gross.toFixed(3)} kg`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  };

  const update = (i: number, patch: Partial<Line>) =>
    setLines(prev => prev.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const totals = lines.reduce(
    (a, l) => ({ qty: a.qty + l.checkedQty,
      value: a.value + (l.rateUom === 'KGS' ? Number(l.netWeightKg ?? 0) : l.checkedQty) * l.rate }),
    { qty: 0, value: 0 }
  );

  const save = async () => {
    if (!partyId || !challanNo || lines.length === 0) {
      setNotice('pick a weaver, enter their challan number, add at least one piece');
      return;
    }
    const dupes = lines.map(l => l.barcode).filter((b, i, a) => a.indexOf(b) !== i);
    if (dupes.length > 0) {
      setNotice(`duplicate barcode on this challan: ${dupes[0]}`);
      return;
    }
    const body = {
      partyId, entryDate: challanDate, challanNo, challanDate, lotNo,
      lines: lines.map(l => ({ ...l, lotNo }))
    };

    if (!isOnline()) {
      await enqueue('/grey-inwards', body);
      setNotice(`No network — ${lines.length} piece(s) queued to post when signal returns`);
      setLines([]);
      setChallanNo('');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const out = await api.post<any>('/grey-inwards', body);
      setNotice(`Inward ${out.entryNo} posted — ${out.pieces} pieces, ₹${out.value.toLocaleString('en-IN')}`);
      setLines([]);
      setChallanNo('');
    } catch (e: any) {
      if (e.message === 'Failed to fetch' || e.message === 'NetworkError') {
        await enqueue('/grey-inwards', body);
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
    <div className="flex flex-col h-full bg-[#ecf1f7] text-slate-800 text-xs"
         onKeyDown={event => {
           if (event.altKey && event.key.toLowerCase() === 's') { event.preventDefault(); void save(); }
           if (event.altKey && event.key.toLowerCase() === 'n') { event.preventDefault(); scanRef.current?.focus(); }
         }}>
      <ToolbarRibbon
        title="Grey Purchase Inward (Barcoding)"
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

      <form onSubmit={addScanned} className="mx-3 mt-3 bg-white rounded border border-[#b8c9dd] p-3 flex items-center gap-2">
          <Barcode className="w-4 h-4 text-blue-700" />
          <label htmlFor="grey-scan" className="font-bold text-blue-900">Scan next thaan</label>
          <input id="grey-scan" ref={scanRef} autoFocus value={scanCode}
                 onChange={event => setScanCode(event.target.value)}
                 placeholder="scan and press Enter" className="erp-input w-64 font-mono" />
          <span className="text-slate-500">Alt+N focuses scanner · Alt+S posts</span>
      </form>

      <div className="p-3 flex-1 overflow-y-auto max-w-7xl mx-auto w-full space-y-3">
        <div className="bg-white rounded border border-[#b8c9dd] p-3 grid grid-cols-1 md:grid-cols-12 gap-2.5">
          <div className="md:col-span-5">
            <label htmlFor="grey-supplier" className="erp-label block text-red-700 font-bold">* Weaver / Grey Supplier</label>
            <select id="grey-supplier" value={partyId} onChange={e => setPartyId(e.target.value)} className="erp-input w-full">
              <option value="">— select —</option>
              {weavers.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </div>
          <div className="md:col-span-3">
            <label htmlFor="grey-challan" className="erp-label block text-red-700 font-bold">* Their Challan No.</label>
            <input id="grey-challan" value={challanNo} onChange={e => setChallanNo(e.target.value)}
                   className="erp-input w-full font-mono" />
          </div>
          <div className="md:col-span-2">
            <label htmlFor="grey-challan-date" className="erp-label block">Challan Date</label>
            <input id="grey-challan-date" type="date" value={challanDate} onChange={e => setChallanDate(e.target.value)}
                   className="erp-input w-full" />
          </div>
          <div className="md:col-span-2">
            <label htmlFor="grey-lot" className="erp-label block">Lot No.</label>
            <input id="grey-lot" value={lotNo} onChange={e => setLotNo(e.target.value)}
                   className="erp-input w-full font-mono" placeholder="1100/B" />
          </div>
        </div>

        <div className="bg-white rounded border border-[#b8c9dd] overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-200">
            <Barcode className="w-4 h-4 text-blue-700" />
            <span className="font-bold text-blue-900">Pieces — one row per thaan</span>
            <button onClick={() => addRow()} className="erp-btn ml-auto">
              <Plus className="w-3.5 h-3.5 text-emerald-600" />
              <span>Add Piece</span>
            </button>
          </div>

          <table className="w-full">
            <thead className="bg-slate-100 border-b border-slate-300 text-left">
              <tr>
                <th className="px-2 py-1.5 font-bold">Sno</th>
                <th className="px-2 py-1.5 font-bold">Barcode</th>
                <th className="px-2 py-1.5 font-bold">Quality</th>
                <th className="px-2 py-1.5 font-bold">Grade</th>
                <th className="px-2 py-1.5 font-bold text-right">Received</th>
                <th className="px-2 py-1.5 font-bold text-right">Checked</th>
                <th className="px-2 py-1.5 font-bold text-right">Gross kg</th>
                <th className="px-2 py-1.5 font-bold text-right">Tare kg</th>
                <th className="px-2 py-1.5 font-bold text-right">Net kg</th>
                <th className="px-2 py-1.5 font-bold text-right">Rate</th>
                <th className="px-2 py-1.5 font-bold">Per</th>
                <th className="px-2 py-1.5 font-bold text-right">Amount</th>
                <th className="px-2 py-1.5"></th>
              </tr>
            </thead>
            <tbody>
              {lines.length === 0 && (
                <tr><td colSpan={13} className="px-2 py-6 text-center text-slate-400">
                  Add a piece to begin
                </td></tr>
              )}
              {lines.map((l, i) => (
                <tr key={i} className="border-b border-slate-100">
                  <td className="px-2 py-1">{i + 1}</td>
                  <td className="px-2 py-1">
                    <input aria-label={`Barcode for piece ${i + 1}`} value={l.barcode} onChange={e => update(i, { barcode: e.target.value })}
                           className="erp-input w-36 font-mono text-blue-800" />
                  </td>
                  <td className="px-2 py-1">
                    <select aria-label={`Quality for piece ${i + 1}`} value={l.qualityId} onChange={e => update(i, { qualityId: e.target.value })}
                            className="erp-input w-40">
                      {(qualities.data ?? []).map(q => (
                        <option key={q.id} value={q.id}>{q.name}</option>
                      ))}
                    </select>
                  </td>
                  <td className="px-2 py-1">
                    <select aria-label={`Grade for piece ${i + 1}`} value={l.gradeCode} onChange={e => update(i, { gradeCode: e.target.value })}
                            className="erp-input w-28">
                      {(grades.data ?? []).map(g => (
                        <option key={g.code} value={g.code}>{g.name}</option>
                      ))}
                    </select>
                  </td>
                  <td className="px-2 py-1 text-right">
                    <input aria-label={`Received metres for piece ${i + 1}`} type="number" step="0.01" value={l.receivedQty}
                           onChange={e => update(i, { receivedQty: Number(e.target.value) })}
                           className="erp-input w-24 text-right font-mono" />
                  </td>
                  <td className="px-2 py-1 text-right">
                    <input aria-label={`Checked metres for piece ${i + 1}`} type="number" step="0.01" value={l.checkedQty}
                           onChange={e => update(i, { checkedQty: Number(e.target.value) })}
                           className="erp-input w-24 text-right font-mono" />
                  </td>
                  <td className="px-2 py-1 text-right">
                    <div className="flex items-center gap-1">
                      <input aria-label={`Gross kilograms for piece ${i + 1}`} type="number" step="0.001"
                             value={l.grossWeightKg ?? ''}
                             onChange={e => {
                               const gross = e.target.value === '' ? null : Number(e.target.value);
                               update(i, { grossWeightKg: gross,
                                 netWeightKg: gross == null ? null : Math.max(0, gross - (l.tareWeightKg ?? 0)) });
                             }} className="erp-input w-20 text-right font-mono" />
                      <button type="button" onClick={() => void readWeight(i)} className="erp-btn px-1" title="Read scale">⚖</button>
                    </div>
                  </td>
                  <td className="px-2 py-1 text-right">
                    <input aria-label={`Tare kilograms for piece ${i + 1}`} type="number" step="0.001"
                           value={l.tareWeightKg ?? ''}
                           onChange={e => {
                             const tare = e.target.value === '' ? null : Number(e.target.value);
                             update(i, { tareWeightKg: tare,
                               netWeightKg: l.grossWeightKg == null || tare == null
                                 ? null : Math.max(0, l.grossWeightKg - tare) });
                           }} className="erp-input w-20 text-right font-mono" />
                  </td>
                  <td className="px-2 py-1 text-right font-mono">
                    {l.netWeightKg == null ? '—' : l.netWeightKg.toFixed(3)}
                  </td>
                  <td className="px-2 py-1 text-right">
                    <input aria-label={`Rate for piece ${i + 1}`} type="number" step="0.01" value={l.rate}
                           onChange={e => update(i, { rate: Number(e.target.value) })}
                           className="erp-input w-20 text-right font-mono" />
                  </td>
                  <td className="px-2 py-1"><select aria-label={`Rate unit for piece ${i + 1}`}
                        value={l.rateUom} onChange={e => update(i, { rateUom: e.target.value as 'MTR' | 'KGS' })}
                        className="erp-input w-20"><option value="MTR">MTR</option><option value="KGS">KGS</option></select></td>
                  <td className="px-2 py-1 text-right font-mono">
                    ₹{((l.rateUom === 'KGS' ? Number(l.netWeightKg ?? 0) : l.checkedQty) * l.rate).toFixed(2)}
                  </td>
                  <td className="px-2 py-1 text-right">
                    <button onClick={() => setLines(prev => prev.filter((_, j) => j !== i))}
                            title="Remove piece" className="text-red-600 hover:text-red-800">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="bg-slate-50 border-t border-slate-300 px-3 py-2 flex items-center justify-end gap-6 font-bold">
            <span>Pieces: {lines.length}</span>
            <span>Qty: {totals.qty.toFixed(2)} MTR</span>
            <span>Value: ₹{totals.value.toFixed(2)}</span>
            <button onClick={save} disabled={busy}
                    className="erp-btn erp-btn-primary font-bold disabled:opacity-60">
              {busy ? 'Posting…' : 'Post Inward'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
