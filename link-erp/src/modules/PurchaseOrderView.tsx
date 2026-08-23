import React, { useState } from 'react';
import { AlertTriangle, CheckCircle2, Plus, Printer, Trash2, X } from 'lucide-react';
import { ToolbarRibbon } from '../components/ToolbarRibbon';
import { ListControls } from '../components/ListControls';
import { useApi, useSubmit } from '../lib/useApi';
import { usePagedList } from '../lib/usePagedList';
import { api, type GradeRow, type LedgerRow, type QualityRow } from '../lib/api';

interface Line {
  qualityId: string;
  gradeCode: string;
  pcs: number;
  cutLength: number;
  rate: number;
}

interface OrderRow {
  id: string; order_no: string; order_date: string; delivery_date: string | null;
  party_name: string; party_gstin: string | null; broker_name: string | null;
  transport_name: string | null; payment_terms: string; remarks: string; status: string;
  lines: { sno: number; quality: string; design: string | null; grade_code: string;
    pcs: number; qty: number; rate: number; amount: number; received_qty: number }[];
}

interface PrintDoc {
  order_no: string; order_date: string; delivery_date: string | null; delivery_days: number;
  payment_terms: string; delivery_terms: string; remarks: string; status: string;
  buyer_name: string; buyer_gstin: string; buyer_address: string | null;
  buyer_address2: string | null; buyer_city: string | null; buyer_pincode: string | null;
  supplier_name: string; supplier_gstin: string | null; supplier_address: string | null;
  supplier_city: string | null; supplier_pincode: string | null; supplier_state: string | null;
  broker_name: string | null; transport_name: string | null; total: number; amount_in_words: string;
  lines: { sno: number; quality: string; construction: string; hsn_code: string;
    design: string | null; grade_code: string; pcs: number; cut_length: number;
    qty: number; rate: number; amount: number; received_qty: number }[];
}

const today = () => new Date().toISOString().slice(0, 10);
const money = (v: number) => `₹${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

const PurchaseOrderPrint: React.FC<{ id: string; onClose: () => void }> = ({ id, onClose }) => {
  const doc = useApi<PrintDoc>(`/grey-purchase-orders/${id}/print`);
  if (doc.error) return <div className="p-4 text-red-700">{doc.error}</div>;
  if (!doc.data) return <div className="p-4 text-slate-600">Loading purchase order…</div>;
  const d = doc.data;

  return (
    <div className="absolute inset-0 z-50 flex items-start justify-center overflow-auto bg-black/40 p-4 print:static print:bg-white print:p-0">
      <article className="print-area w-full max-w-4xl border border-slate-400 bg-white">
        <div className="flex items-center gap-2 bg-blue-800 px-3 py-2 text-white print:hidden">
          <strong>Grey Purchase Order — {d.order_no}</strong>
          <button type="button" onClick={() => window.print()} className="erp-btn ml-auto" title="Print purchase order">
            <Printer className="h-3.5 w-3.5" /> Print
          </button>
          <button type="button" onClick={onClose} aria-label="Close purchase order preview"><X className="h-5 w-5" /></button>
        </div>
        <div className="p-6 text-xs">
          <h2 className="text-center text-base font-bold">PURCHASE ORDER</h2>
          <p className="mb-4 text-center text-[10px] text-slate-600">Grey fabric</p>
          <div className="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <section className="border border-slate-400 p-3">
              <div className="text-[10px] font-bold uppercase text-slate-500">Buyer</div>
              <div className="font-bold">{d.buyer_name}</div>
              <div>{[d.buyer_address, d.buyer_address2].filter(Boolean).join(', ') || '—'}</div>
              <div>{d.buyer_city ?? '—'} {d.buyer_pincode ? `— ${d.buyer_pincode}` : ''}</div>
              <div>GSTIN: <span className="font-mono">{d.buyer_gstin}</span></div>
            </section>
            <section className="border border-slate-400 p-3">
              <div className="text-[10px] font-bold uppercase text-slate-500">Supplier</div>
              <div className="font-bold">{d.supplier_name}</div>
              <div>{d.supplier_address ?? '—'}</div>
              <div>{d.supplier_city ?? '—'} {d.supplier_pincode ? `— ${d.supplier_pincode}` : ''}</div>
              <div>GSTIN: <span className="font-mono">{d.supplier_gstin ?? 'URP'}</span></div>
            </section>
          </div>
          <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div><span className="text-slate-500">PO no.</span><div className="font-mono font-bold">{d.order_no}</div></div>
            <div><span className="text-slate-500">PO date</span><div className="font-bold">{d.order_date}</div></div>
            <div><span className="text-slate-500">Delivery by</span><div>{d.delivery_date ?? `${d.delivery_days} day(s)`}</div></div>
            <div><span className="text-slate-500">Status</span><div className="font-bold uppercase">{d.status.replaceAll('_', ' ')}</div></div>
          </div>
          <table className="mb-3 w-full border border-slate-400">
            <thead className="bg-slate-100">
              <tr>
                <th>S.No.</th><th>Description</th><th>HSN</th><th>Grade</th>
                <th className="text-right">Pcs</th><th className="text-right">Cut</th>
                <th className="text-right">Qty</th><th className="text-right">Rate</th>
                <th className="text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {d.lines.map(line => (
                <tr key={line.sno}>
                  <td className="text-center">{line.sno}</td>
                  <td><strong>{line.quality}</strong>{line.design ? ` / ${line.design}` : ''}
                    {line.construction && <div className="text-[10px] text-slate-500">{line.construction}</div>}
                  </td>
                  <td className="font-mono">{line.hsn_code}</td><td>{line.grade_code}</td>
                  <td className="text-right font-mono">{line.pcs}</td>
                  <td className="text-right font-mono">{Number(line.cut_length).toFixed(2)}</td>
                  <td className="text-right font-mono">{Number(line.qty).toFixed(2)}</td>
                  <td className="text-right font-mono">{money(line.rate)}</td>
                  <td className="text-right font-mono">{money(line.amount)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr className="bg-slate-50 font-bold"><td colSpan={8}>Total</td><td className="text-right">{money(d.total)}</td></tr></tfoot>
          </table>
          <p><span className="text-slate-500">Amount in words:</span> <strong>{d.amount_in_words}</strong></p>
          <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div><span className="text-slate-500">Payment terms:</span> {d.payment_terms || '—'}</div>
            <div><span className="text-slate-500">Transport:</span> {d.transport_name ?? '—'}</div>
            <div><span className="text-slate-500">Broker:</span> {d.broker_name ?? '—'}</div>
            <div><span className="text-slate-500">Remarks:</span> {d.remarks || '—'}</div>
          </div>
          <div className="mt-14 text-right">For {d.buyer_name}<div className="mt-8 text-[10px]">Authorised signatory</div></div>
        </div>
      </article>
    </div>
  );
};

export const PurchaseOrderView: React.FC = () => {
  const [partyId, setPartyId] = useState('');
  const [orderDate, setOrderDate] = useState(today());
  const [deliveryDate, setDeliveryDate] = useState('');
  const [deliveryDays, setDeliveryDays] = useState(15);
  const [brokerId, setBrokerId] = useState('');
  const [transportId, setTransportId] = useState('');
  const [paymentTerms, setPaymentTerms] = useState('');
  const [remarks, setRemarks] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [printing, setPrinting] = useState<string | null>(null);

  const ledgers = useApi<LedgerRow[]>('/ledgers');
  const controls = useApi<{ id: string; nature: string }[]>('/control-accounts');
  const qualities = useApi<QualityRow[]>('/qualities');
  const grades = useApi<GradeRow[]>('/grades');
  const orders = usePagedList<OrderRow>('/grey-purchase-orders', 50, 'purchase_orders');
  const { submit, busy, error } = useSubmit<unknown, { id: string; orderNo: string }>('/grey-purchase-orders');

  const controlIds = (nature: string) => new Set((controls.data ?? []).filter(c => c.nature === nature).map(c => c.id));
  const suppliers = (ledgers.data ?? []).filter(l => controlIds('sundry_creditor_grey').has(l.control_account_id));
  const brokers = (ledgers.data ?? []).filter(l => controlIds('sundry_creditor_brokerage').has(l.control_account_id));
  const transports = (ledgers.data ?? []).filter(l => controlIds('sundry_creditor_transport').has(l.control_account_id));

  const addLine = () => {
    const quality = qualities.data?.[0];
    const grade = grades.data?.[0];
    if (!quality || !grade) { setNotice('Create a quality and grade before booking a purchase order'); return; }
    setLines(old => [...old, { qualityId: quality.id, gradeCode: grade.code, pcs: 10, cutLength: 100, rate: 30 }]);
  };
  const update = (index: number, patch: Partial<Line>) =>
    setLines(old => old.map((line, i) => i === index ? { ...line, ...patch } : line));
  const qtyFor = (line: Line) => line.pcs * line.cutLength;
  const total = lines.reduce((sum, line) => sum + qtyFor(line) * line.rate, 0);
  const applyMasterRate = async (i: number) => {
    if (!partyId) { setNotice('Pick a grey supplier before looking up a purchase rate'); return; }
    try {
      const found = await api.get<{ rate: number }>(`/configuration/rate?partyId=${partyId}&qualityId=${lines[i]!.qualityId}&kind=purchase&date=${orderDate}`);
      update(i, { rate: Number(found.rate) });
      setNotice(`Purchase rate ${money(Number(found.rate))} applied from the valid contract`);
    } catch (e) { setNotice(e instanceof Error ? e.message : String(e)); }
  };

  const reset = () => {
    setLines([]); setNotice(null); setRemarks(''); setPaymentTerms('');
  };
  const save = async () => {
    if (!partyId || lines.length === 0) { setNotice('Pick a grey supplier and add at least one line'); return; }
    const out = await submit({
      partyId, orderDate, deliveryDate: deliveryDate || null, deliveryDays,
      brokerId: brokerId || null, transportId: transportId || null,
      paymentTerms, remarks,
      lines: lines.map(line => ({ ...line, designId: null, qty: qtyFor(line) }))
    });
    if (out) {
      setNotice(`Purchase order ${out.orderNo} booked — ${money(total)}`);
      setLines([]); orders.reload();
    }
  };

  return (
    <div className="flex h-full flex-col bg-[#ecf1f7] text-xs text-slate-800">
      <ToolbarRibbon title="Grey Purchase Order" onSave={save} onNew={reset}
        onExport={() => void orders.exportCsv()} onPrint={() => window.print()} />
      {(notice || error) && <div className={`flex items-center gap-2 px-4 py-1.5 font-semibold text-white ${error ? 'bg-red-600' : 'bg-emerald-700'}`}>
        {error ? <AlertTriangle className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
        <span>{error ?? notice}</span>
      </div>}
      <div className="flex-1 space-y-3 overflow-auto p-3">
        <section className="grid grid-cols-1 gap-2.5 rounded border border-[#b8c9dd] bg-white p-3 md:grid-cols-12">
          <label className="md:col-span-4"><span className="erp-label block font-bold text-red-700">* Grey supplier</span>
            <select aria-label="Grey supplier" value={partyId} onChange={e => setPartyId(e.target.value)} className="erp-input w-full">
              <option value="">— select —</option>{suppliers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <label className="md:col-span-2"><span className="erp-label block">Order date</span><input aria-label="Purchase order date" type="date" value={orderDate} onChange={e => setOrderDate(e.target.value)} className="erp-input w-full" /></label>
          <label className="md:col-span-2"><span className="erp-label block">Delivery by</span><input aria-label="Expected delivery date" type="date" value={deliveryDate} onChange={e => setDeliveryDate(e.target.value)} className="erp-input w-full" /></label>
          <label className="md:col-span-2"><span className="erp-label block">Delivery days</span><input aria-label="Delivery days" type="number" min="0" value={deliveryDays} onChange={e => setDeliveryDays(Number(e.target.value))} className="erp-input w-full" /></label>
          <label className="md:col-span-2"><span className="erp-label block">Payment terms</span><input aria-label="Purchase payment terms" value={paymentTerms} onChange={e => setPaymentTerms(e.target.value)} className="erp-input w-full" /></label>
          <label className="md:col-span-3"><span className="erp-label block">Broker</span><select aria-label="Purchase broker" value={brokerId} onChange={e => setBrokerId(e.target.value)} className="erp-input w-full"><option value="">None</option>{brokers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
          <label className="md:col-span-3"><span className="erp-label block">Transport</span><select aria-label="Purchase transport" value={transportId} onChange={e => setTransportId(e.target.value)} className="erp-input w-full"><option value="">None</option>{transports.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
          <label className="md:col-span-6"><span className="erp-label block">Remarks</span><input aria-label="Purchase order remarks" value={remarks} onChange={e => setRemarks(e.target.value)} className="erp-input w-full" /></label>
        </section>

        <section className="overflow-auto rounded border border-[#b8c9dd] bg-white">
          <header className="flex items-center gap-2 border-b border-slate-200 px-3 py-2"><strong className="text-blue-900">Order lines</strong><button type="button" onClick={addLine} className="erp-btn ml-auto"><Plus className="h-3.5 w-3.5 text-emerald-700" /> Add line</button></header>
          <table className="min-w-[760px] w-full"><thead className="border-b border-slate-300 bg-slate-100"><tr><th>Quality</th><th>Grade</th><th className="text-right">Pcs</th><th className="text-right">Cut</th><th className="text-right">Qty</th><th className="text-right">Rate</th><th className="text-right">Amount</th><th aria-label="Actions"></th></tr></thead>
            <tbody>{lines.map((line, i) => <tr key={i} className="border-b border-slate-100">
              <td><select aria-label={`Quality for purchase order line ${i + 1}`} value={line.qualityId} onChange={e => update(i, { qualityId: e.target.value })} className="erp-input w-full">{(qualities.data ?? []).map(q => <option key={q.id} value={q.id}>{q.name}</option>)}</select></td>
              <td><select aria-label={`Grade for purchase order line ${i + 1}`} value={line.gradeCode} onChange={e => update(i, { gradeCode: e.target.value })} className="erp-input w-full">{(grades.data ?? []).map(g => <option key={g.code} value={g.code}>{g.name}</option>)}</select></td>
              <td><input aria-label={`Pieces for purchase order line ${i + 1}`} type="number" min="1" value={line.pcs} onChange={e => update(i, { pcs: Number(e.target.value) })} className="erp-input w-24 text-right" /></td>
              <td><input aria-label={`Cut length for purchase order line ${i + 1}`} type="number" min="0.01" step="0.01" value={line.cutLength} onChange={e => update(i, { cutLength: Number(e.target.value) })} className="erp-input w-24 text-right" /></td>
              <td className="text-right font-mono">{qtyFor(line).toFixed(2)}</td>
              <td><input aria-label={`Rate for purchase order line ${i + 1}`} type="number" min="0" step="0.01" value={line.rate} onChange={e => update(i, { rate: Number(e.target.value) })} className="erp-input w-24 text-right" /><button type="button" onClick={() => void applyMasterRate(i)} className="erp-btn ml-1" title="Apply valid purchase rate contract">Master</button></td>
              <td className="text-right font-mono">{money(qtyFor(line) * line.rate)}</td>
              <td><button type="button" onClick={() => setLines(old => old.filter((_, j) => j !== i))} className="erp-btn" title={`Remove purchase order line ${i + 1}`}><Trash2 className="h-4 w-4 text-red-700" /></button></td>
            </tr>)}{lines.length === 0 && <tr><td colSpan={8} className="p-6 text-center text-slate-500">Add the fabric agreed with the supplier</td></tr>}</tbody>
          </table>
          <footer className="flex items-center justify-end gap-5 border-t border-slate-300 bg-slate-50 px-3 py-2"><strong>Order value: {money(total)}</strong><button type="button" onClick={save} disabled={busy} className="erp-btn erp-btn-primary disabled:opacity-60">{busy ? 'Booking…' : 'Book purchase order'}</button></footer>
        </section>

        <section className="overflow-auto rounded border border-[#b8c9dd] bg-white">
          <header className="border-b border-slate-200 px-3 py-2 font-bold text-blue-900">Purchase orders and receipt balance</header>
          <ListControls list={orders} placeholder="PO no, supplier or remarks…" />
          <table className="min-w-[900px] w-full"><thead className="border-b border-slate-300 bg-slate-100"><tr><th>PO</th><th>Date</th><th>Supplier</th><th>Quality</th><th className="text-right">Ordered</th><th className="text-right">Received</th><th className="text-right">Pending</th><th className="text-right">Amount</th><th>Status</th><th aria-label="Actions"></th></tr></thead>
            <tbody>{orders.rows.flatMap(order => order.lines.map(line => <tr key={`${order.id}-${line.sno}`} className="border-b border-slate-100">
              <td className="font-mono font-bold text-blue-800">{order.order_no}</td><td>{order.order_date}</td><td>{order.party_name}</td><td>{line.quality}</td>
              <td className="text-right font-mono">{Number(line.qty).toFixed(2)}</td><td className="text-right font-mono">{Number(line.received_qty).toFixed(2)}</td><td className="text-right font-mono font-bold">{(Number(line.qty) - Number(line.received_qty)).toFixed(2)}</td><td className="text-right font-mono">{money(line.amount)}</td><td>{order.status.replaceAll('_', ' ')}</td>
              <td><button type="button" onClick={() => setPrinting(order.id)} className="erp-btn" title={`Print purchase order ${order.order_no}`}><Printer className="h-4 w-4 text-blue-700" /></button></td>
            </tr>))}{!orders.loading && orders.rows.length === 0 && <tr><td colSpan={10} className="p-6 text-center text-slate-500">No purchase orders booked yet</td></tr>}</tbody>
          </table>
        </section>
      </div>
      {printing && <PurchaseOrderPrint id={printing} onClose={() => setPrinting(null)} />}
    </div>
  );
};
