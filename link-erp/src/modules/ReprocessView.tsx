import React, { useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Printer, QrCode, Trash2, X } from 'lucide-react';
import { ToolbarRibbon } from '../components/ToolbarRibbon';
import { ListControls } from '../components/ListControls';
import { api, type GradeRow, type LedgerRow, type PieceRow } from '../lib/api';
import { useApi } from '../lib/useApi';
import { usePagedList } from '../lib/usePagedList';

interface ReprocessLine {
  id: string; sno: number; issued_qty: number; original_grade: string;
  barcode: string; status: string; quality: string; receipt_no: string | null;
  receipt_status: string | null; received_qty: number | null;
  additional_rate: number | null; finish_grade: string | null;
}
interface ReprocessRow {
  id: string; issue_no: string; issue_date: string; challan_no: string; challan_date: string;
  reason: string; status: string; process_house_id: string; process_house: string;
  lines: ReprocessLine[];
}
interface ReceiptLine {
  barcode: string; quality: string; issuedQty: number; receivedQty: number;
  additionalRate: number; finishGrade: string;
}
interface ReprocessPrintDoc {
  issue_no: string; issue_date: string; challan_no: string; challan_date: string;
  reason: string; status: string; mill_name: string; mill_gstin: string;
  mill_address: string | null; mill_city: string | null; mill_pincode: string | null;
  process_house: string; process_house_gstin: string | null; process_address: string | null;
  process_city: string | null; process_pincode: string | null; pieces: number; total_qty: number;
  lines: { sno: number; barcode: string; quality: string; hsn_code: string;
    original_grade: string; issued_qty: number; uom: string }[];
}

const today = () => new Date().toISOString().slice(0, 10);

const ReprocessPrint: React.FC<{ id: string; onClose: () => void }> = ({ id, onClose }) => {
  const doc = useApi<ReprocessPrintDoc>(`/dyeing-reprocesses/${id}/print`);
  if (doc.error) return <div className="p-4 text-red-700">{doc.error}</div>;
  if (!doc.data) return <div className="p-4 text-slate-600">Loading reprocess challan…</div>;
  const d = doc.data;
  return <div className="absolute inset-0 z-50 flex items-start justify-center overflow-auto bg-black/40 p-4 print:static print:bg-white print:p-0">
    <article className="print-area w-full max-w-4xl border border-slate-400 bg-white">
      <div className="flex items-center gap-2 bg-blue-800 px-3 py-2 text-white print:hidden"><strong>Reprocess challan — {d.issue_no}</strong><button type="button" className="erp-btn ml-auto" onClick={() => window.print()}><Printer className="h-4 w-4" /> Print</button><button type="button" onClick={onClose} aria-label="Close reprocess print preview"><X className="h-5 w-5" /></button></div>
      <div className="p-6 text-xs">
        <h2 className="text-center text-base font-bold">DELIVERY CHALLAN — REPROCESS / CORRECTION</h2>
        <p className="mb-4 text-center text-[10px] text-slate-600">Goods remain owned by the mill; this document is not a sale.</p>
        <div className="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <section className="border border-slate-400 p-3"><span className="text-[10px] font-bold uppercase text-slate-500">Mill</span><div className="font-bold">{d.mill_name}</div><div>{d.mill_address ?? '—'}</div><div>{d.mill_city ?? '—'} {d.mill_pincode ? `— ${d.mill_pincode}` : ''}</div><div>GSTIN: <span className="font-mono">{d.mill_gstin}</span></div></section>
          <section className="border border-slate-400 p-3"><span className="text-[10px] font-bold uppercase text-slate-500">Process house</span><div className="font-bold">{d.process_house}</div><div>{d.process_address ?? '—'}</div><div>{d.process_city ?? '—'} {d.process_pincode ? `— ${d.process_pincode}` : ''}</div><div>GSTIN: <span className="font-mono">{d.process_house_gstin ?? 'URP'}</span></div></section>
        </div>
        <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4"><div><span className="text-slate-500">Internal no.</span><div className="font-mono font-bold">{d.issue_no}</div></div><div><span className="text-slate-500">Issue date</span><div>{d.issue_date}</div></div><div><span className="text-slate-500">Challan</span><div className="font-mono">{d.challan_no}</div></div><div><span className="text-slate-500">Challan date</span><div>{d.challan_date}</div></div></div>
        <table className="w-full"><thead><tr><th>S.No.</th><th>Barcode</th><th>Quality</th><th>HSN</th><th>Grade</th><th className="text-right">Qty</th><th>UQC</th></tr></thead><tbody>{d.lines.map(line => <tr key={line.sno}><td className="text-center">{line.sno}</td><td className="font-mono">{line.barcode}</td><td>{line.quality}</td><td className="font-mono">{line.hsn_code}</td><td>{line.original_grade}</td><td className="text-right font-mono">{Number(line.issued_qty).toFixed(2)}</td><td>{line.uom}</td></tr>)}</tbody><tfoot><tr className="font-bold"><td colSpan={4}>Total</td><td className="text-right">{d.pieces} pcs</td><td className="text-right">{Number(d.total_qty).toFixed(2)}</td><td>MTR</td></tr></tfoot></table>
        <p className="mt-4"><span className="text-slate-500">Reason / work required:</span> <strong>{d.reason}</strong></p>
        <div className="mt-14 flex justify-between"><span>Received by process house</span><span>For {d.mill_name}<span className="mt-8 block text-right text-[10px]">Authorised signatory</span></span></div>
      </div>
    </article>
  </div>;
};

export const ReprocessView: React.FC = () => {
  const [processHouseId, setProcessHouseId] = useState('');
  const [issueDate, setIssueDate] = useState(today());
  const [issueChallan, setIssueChallan] = useState('');
  const [reason, setReason] = useState('');
  const [issueScan, setIssueScan] = useState('');
  const [issuePieces, setIssuePieces] = useState<PieceRow[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [receiptDate, setReceiptDate] = useState(today());
  const [receiptChallan, setReceiptChallan] = useState('');
  const [receiptScan, setReceiptScan] = useState('');
  const [receiptLines, setReceiptLines] = useState<ReceiptLine[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [printing, setPrinting] = useState<string | null>(null);

  const ledgers = useApi<LedgerRow[]>('/ledgers');
  const controls = useApi<{ id: string; nature: string }[]>('/control-accounts');
  const grades = useApi<GradeRow[]>('/grades');
  const finish = useApi<PieceRow[]>('/pieces?status=received_finish&limit=100000');
  const list = usePagedList<ReprocessRow>('/dyeing-reprocesses');
  const processControlIds = new Set((controls.data ?? []).filter(c => c.nature === 'sundry_creditor_process').map(c => c.id));
  const processHouses = (ledgers.data ?? []).filter(ledger => processControlIds.has(ledger.control_account_id));
  const selected = useMemo(() => list.rows.find(row => row.id === selectedId) ?? null, [list.rows, selectedId]);
  const outstanding = selected?.lines.filter(line => !line.receipt_status) ?? [];

  const scanIssue = (event: React.FormEvent) => {
    event.preventDefault(); const code = issueScan.trim(); setIssueScan(''); if (!code) return;
    if (issuePieces.some(piece => piece.barcode === code)) { setNotice(`${code} is already on the challan`); return; }
    const piece = (finish.data ?? []).find(row => row.barcode === code);
    if (!piece) { setNotice(`${code} is not received finish stock`); return; }
    setIssuePieces(old => [...old, piece]); setNotice(null);
  };
  const saveIssue = async () => {
    if (!processHouseId || !issueChallan.trim() || reason.trim().length < 3 || issuePieces.length === 0) {
      setNotice('Choose the process house, enter challan and reason, and scan at least one finish piece'); return;
    }
    setBusy(true); setError(null);
    try {
      const out = await api.post<any>('/dyeing-reprocesses', { processHouseId, issueDate,
        challanNo: issueChallan.trim(), challanDate: issueDate, reason: reason.trim(),
        barcodes: issuePieces.map(piece => piece.barcode) });
      setNotice(`${out.issueNo} posted — ${out.pieces} piece(s), ${out.qty} m sent for correction`);
      setIssuePieces([]); setIssueChallan(''); setReason(''); finish.reload(); list.reload();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const scanReceipt = (event: React.FormEvent) => {
    event.preventDefault(); const code = receiptScan.trim(); setReceiptScan(''); if (!code) return;
    if (receiptLines.some(line => line.barcode === code)) { setNotice(`${code} is already on this receipt`); return; }
    const source = outstanding.find(line => line.barcode === code);
    if (!source) { setNotice(`${code} is not outstanding on the selected reprocess challan`); return; }
    setReceiptLines(old => [...old, { barcode: source.barcode, quality: source.quality,
      issuedQty: Number(source.issued_qty), receivedQty: Number(source.issued_qty),
      additionalRate: 0, finishGrade: source.original_grade }]); setNotice(null);
  };
  const updateReceipt = (index: number, patch: Partial<ReceiptLine>) =>
    setReceiptLines(old => old.map((line, i) => i === index ? { ...line, ...patch } : line));
  const saveReceipt = async () => {
    if (!selectedId || !receiptChallan.trim() || receiptLines.length === 0) {
      setNotice('Select an open reprocess challan, enter the process-house challan, and scan returned pieces'); return;
    }
    setBusy(true); setError(null);
    try {
      const out = await api.post<any>('/dyeing-reprocess-receipts', { reprocessId: selectedId,
        receiptDate, challanNo: receiptChallan.trim(), challanDate: receiptDate,
        lines: receiptLines.map(({ barcode, receivedQty, additionalRate, finishGrade }) => ({ barcode, receivedQty, additionalRate, finishGrade })) });
      setNotice(out.status === 'pending_approval'
        ? `${out.receiptNo} submitted — stock and ₹${Number(out.amount).toFixed(2)} charge wait for a second person`
        : `${out.receiptNo} posted — ${out.pieces} piece(s) received`);
      setReceiptLines([]); setReceiptChallan(''); list.reload(); finish.reload();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  return <div className="flex h-full flex-col bg-[#ecf1f7] text-xs text-slate-800">
    <ToolbarRibbon title="Dyeing Reprocess / Rework" onSave={saveIssue} onNew={() => { setIssuePieces([]); setReceiptLines([]); setNotice(null); }} onExport={() => void list.exportCsv()} onPrint={() => window.print()} />
    {(notice || error) && <div className={`flex items-center gap-2 px-4 py-1.5 font-semibold text-white ${error ? 'bg-red-600' : 'bg-emerald-700'}`}>{error ? <AlertTriangle className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}<span>{error ?? notice}</span></div>}
    <div className="flex-1 space-y-3 overflow-auto p-3">
      <section className="rounded border border-[#b8c9dd] bg-white">
        <header className="border-b border-slate-200 bg-blue-50 px-3 py-2 font-bold text-blue-950">1. Send rejected finish back for correction</header>
        <div className="grid grid-cols-1 gap-2.5 p-3 md:grid-cols-12">
          <label className="md:col-span-4"><span className="erp-label block font-bold text-red-700">* Process house</span><select aria-label="Reprocess house" value={processHouseId} onChange={e => setProcessHouseId(e.target.value)} className="erp-input w-full"><option value="">— select —</option>{processHouses.map(house => <option key={house.id} value={house.id}>{house.name}</option>)}</select></label>
          <label className="md:col-span-2"><span className="erp-label block">Issue date</span><input aria-label="Reprocess issue date" type="date" value={issueDate} onChange={e => setIssueDate(e.target.value)} className="erp-input w-full" /></label>
          <label className="md:col-span-2"><span className="erp-label block font-bold text-red-700">* Challan no.</span><input aria-label="Reprocess challan number" value={issueChallan} onChange={e => setIssueChallan(e.target.value)} className="erp-input w-full" /></label>
          <label className="md:col-span-4"><span className="erp-label block font-bold text-red-700">* Defect / correction required</span><input aria-label="Reprocess reason" value={reason} onChange={e => setReason(e.target.value)} className="erp-input w-full" /></label>
        </div>
        <form onSubmit={scanIssue} className="flex gap-2 border-t border-slate-200 p-3"><label className="flex-1"><span className="erp-label block">Scan finish barcode</span><div className="relative"><QrCode className="absolute left-2 top-3.5 h-4 w-4 text-blue-700" /><input aria-label="Scan finish barcode for reprocess" value={issueScan} onChange={e => setIssueScan(e.target.value)} className="erp-input w-full pl-8 font-mono" /></div></label><button className="erp-btn mt-5" type="submit">Add scan</button><button className="erp-btn erp-btn-primary mt-5" type="button" disabled={busy} onClick={saveIssue}>Post reprocess issue</button></form>
        {issuePieces.length > 0 && <div className="overflow-auto"><table className="min-w-[600px] w-full"><thead><tr><th>Barcode</th><th>Quality</th><th>Grade</th><th className="text-right">Qty</th><th></th></tr></thead><tbody>{issuePieces.map(piece => <tr key={piece.id}><td className="font-mono">{piece.barcode}</td><td>{piece.quality}</td><td>{piece.grade_code}</td><td className="text-right font-mono">{Number(piece.current_qty).toFixed(2)}</td><td><button type="button" className="erp-btn" title={`Remove ${piece.barcode}`} onClick={() => setIssuePieces(old => old.filter(row => row.id !== piece.id))}><Trash2 className="h-4 w-4 text-red-700" /></button></td></tr>)}</tbody></table></div>}
      </section>

      <section className="rounded border border-[#b8c9dd] bg-white">
        <header className="border-b border-slate-200 bg-emerald-50 px-3 py-2 font-bold text-emerald-950">2. Receive corrected finish and record only the incremental charge</header>
        <div className="grid grid-cols-1 gap-2.5 p-3 md:grid-cols-12">
          <label className="md:col-span-5"><span className="erp-label block font-bold text-red-700">* Open reprocess challan</span><select aria-label="Open reprocess challan" value={selectedId} onChange={e => { setSelectedId(e.target.value); setReceiptLines([]); }} className="erp-input w-full"><option value="">— select —</option>{list.rows.filter(row => !['closed','cancelled'].includes(row.status)).map(row => <option key={row.id} value={row.id}>{row.issue_no} · {row.process_house} · {row.lines.filter(line => !line.receipt_status).length} pending</option>)}</select></label>
          <label className="md:col-span-2"><span className="erp-label block">Receipt date</span><input aria-label="Reprocess receipt date" type="date" value={receiptDate} onChange={e => setReceiptDate(e.target.value)} className="erp-input w-full" /></label>
          <label className="md:col-span-3"><span className="erp-label block font-bold text-red-700">* Process-house challan</span><input aria-label="Reprocess receipt challan number" value={receiptChallan} onChange={e => setReceiptChallan(e.target.value)} className="erp-input w-full" /></label>
          {selected && <button type="button" onClick={() => setPrinting(selected.id)} className="erp-btn mt-5 md:col-span-2"><Printer className="h-4 w-4 text-blue-700" /> Issue challan</button>}
        </div>
        <form onSubmit={scanReceipt} className="flex gap-2 border-t border-slate-200 p-3"><label className="flex-1"><span className="erp-label block">Scan returned barcode</span><input aria-label="Scan returned reprocess barcode" value={receiptScan} onChange={e => setReceiptScan(e.target.value)} className="erp-input w-full font-mono" /></label><button className="erp-btn mt-5" type="submit">Add scan</button><button className="erp-btn erp-btn-primary mt-5" type="button" disabled={busy} onClick={saveReceipt}>Submit receipt</button></form>
        {receiptLines.length > 0 && <div className="overflow-auto"><table className="min-w-[800px] w-full"><thead><tr><th>Barcode</th><th>Quality</th><th className="text-right">Sent qty</th><th className="text-right">Received qty</th><th className="text-right">Extra rate</th><th>Finish grade</th><th></th></tr></thead><tbody>{receiptLines.map((line, i) => <tr key={line.barcode}><td className="font-mono">{line.barcode}</td><td>{line.quality}</td><td className="text-right font-mono">{line.issuedQty.toFixed(2)}</td><td><input aria-label={`Received quantity for ${line.barcode}`} type="number" min="0.01" step="0.01" value={line.receivedQty} onChange={e => updateReceipt(i, { receivedQty: Number(e.target.value) })} className="erp-input w-28 text-right" /></td><td><input aria-label={`Additional rate for ${line.barcode}`} type="number" min="0" step="0.01" value={line.additionalRate} onChange={e => updateReceipt(i, { additionalRate: Number(e.target.value) })} className="erp-input w-28 text-right" /></td><td><select aria-label={`Finish grade for ${line.barcode}`} value={line.finishGrade} onChange={e => updateReceipt(i, { finishGrade: e.target.value })} className="erp-input w-full">{(grades.data ?? []).map(grade => <option key={grade.code} value={grade.code}>{grade.name}</option>)}</select></td><td><button type="button" className="erp-btn" onClick={() => setReceiptLines(old => old.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4 text-red-700" /></button></td></tr>)}</tbody></table></div>}
      </section>

      <section className="overflow-auto rounded border border-[#b8c9dd] bg-white"><header className="border-b border-slate-200 px-3 py-2 font-bold text-blue-900">Reprocess register</header><ListControls list={list} placeholder="Issue, challan, process house or reason…" /><table className="min-w-[900px] w-full"><thead><tr><th>Issue</th><th>Date</th><th>Process house</th><th>Barcode</th><th>Quality</th><th className="text-right">Sent</th><th>Receipt</th><th className="text-right">Back</th><th>Status</th><th></th></tr></thead><tbody>{list.rows.flatMap(row => row.lines.map(line => <tr key={`${row.id}-${line.id}`}><td className="font-mono font-bold text-blue-800">{row.issue_no}</td><td>{row.issue_date}</td><td>{row.process_house}</td><td className="font-mono">{line.barcode}</td><td>{line.quality}</td><td className="text-right font-mono">{Number(line.issued_qty).toFixed(2)}</td><td className="font-mono">{line.receipt_no ?? 'pending'}</td><td className="text-right font-mono">{line.received_qty == null ? '—' : Number(line.received_qty).toFixed(2)}</td><td>{line.receipt_status ?? row.status}</td><td><button type="button" className="erp-btn" title={`Print reprocess challan ${row.issue_no}`} onClick={() => setPrinting(row.id)}><Printer className="h-4 w-4 text-blue-700" /></button></td></tr>))}{!list.loading && list.rows.length === 0 && <tr><td colSpan={10} className="p-6 text-center text-slate-500">No reprocess work recorded</td></tr>}</tbody></table></section>
    </div>
    {printing && <ReprocessPrint id={printing} onClose={() => setPrinting(null)} />}
  </div>;
};
