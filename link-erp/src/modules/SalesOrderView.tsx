import React, { useState } from 'react';
import { ToolbarRibbon } from '../components/ToolbarRibbon';
import { usePagedList } from '../lib/usePagedList';
import { ListControls } from '../components/ListControls';
import { useApi, useSubmit } from '../lib/useApi';
import type { GradeRow, LedgerRow, QualityRow } from '../lib/api';
import { AlertTriangle, CheckCircle2, Plus, Trash2 } from 'lucide-react';

interface Line {
  qualityId: string; gradeCode: string; pcs: number; cutLength: number; rate: number;
}

interface OrderRow {
  id: string; order_no: string; order_date: string; party_name: string;
  destination: string; delivery_date: string | null; status: string;
  lines: { sno: number; quality: string; design: string | null; grade_code: string;
           pcs: number; qty: number; rate: number; amount: number; dispatched_qty: number }[];
}

const money = (v: number) => `₹${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
const today = () => new Date().toISOString().slice(0, 10);

/** Finish sales orders: what the customer committed to, and what is still owed. */
export const SalesOrderView: React.FC = () => {
  const [partyId, setPartyId] = useState('');
  const [orderDate, setOrderDate] = useState(today());
  const [destination, setDestination] = useState('');
  const [deliveryDays, setDeliveryDays] = useState(15);
  const [paymentTerms, setPaymentTerms] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  const ledgers = useApi<LedgerRow[]>('/ledgers');
  const controls = useApi<{ id: string; nature: string }[]>('/control-accounts');
  const qualities = useApi<QualityRow[]>('/qualities');
  const grades = useApi<GradeRow[]>('/grades');
  const orders = usePagedList<OrderRow>('/sales-orders');
  const { submit, busy, error } = useSubmit<unknown, any>('/sales-orders');

  const debtorIds = new Set(
    (controls.data ?? []).filter(c => c.nature === 'sundry_debtor_finish').map(c => c.id)
  );
  const customers = (ledgers.data ?? []).filter(l => debtorIds.has(l.control_account_id));

  const addLine = () => {
    const q = qualities.data?.[0];
    const g = grades.data?.[0];
    if (!q || !g) return;
    setLines(prev => [...prev,
      { qualityId: q.id, gradeCode: g.code, pcs: 10, cutLength: 100, rate: 80 }]);
  };

  const update = (i: number, patch: Partial<Line>) =>
    setLines(prev => prev.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const lineQty = (l: Line) => l.pcs * l.cutLength;
  const total = lines.reduce((n, l) => n + lineQty(l) * l.rate, 0);

  const save = async () => {
    if (!partyId || lines.length === 0) {
      setNotice('pick a customer and add at least one line');
      return;
    }
    const out = await submit({
      partyId, orderDate, destination, deliveryDays, paymentTerms,
      lines: lines.map(l => ({ ...l, qty: lineQty(l) }))
    });
    if (out) {
      setNotice(`Order ${out.orderNo} booked — ${money(total)}`);
      setLines([]);
      orders.reload();
    }
  };

  return (
    <div className="flex flex-col h-full bg-[#ecf1f7] text-slate-800 text-xs">
      <ToolbarRibbon
        title="Finish Sales Order"
        onSave={save}
        onNew={() => { setLines([]); setNotice(null); }}
        onExport={() => void orders.exportCsv()}
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

      <div className="flex-1 overflow-auto p-3 space-y-3">
        <div className="bg-white rounded border border-[#b8c9dd] p-3 grid grid-cols-12 gap-2.5">
          <div className="col-span-4">
            <label className="erp-label block text-red-700 font-bold">* Customer</label>
            <select value={partyId} onChange={e => setPartyId(e.target.value)} className="erp-input w-full">
              <option value="">— select —</option>
              {customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div className="col-span-2">
            <label className="erp-label block">Order Date</label>
            <input type="date" value={orderDate} onChange={e => setOrderDate(e.target.value)}
                   className="erp-input w-full" />
          </div>
          <div className="col-span-2">
            <label className="erp-label block">Destination</label>
            <input value={destination} onChange={e => setDestination(e.target.value)}
                   className="erp-input w-full" />
          </div>
          <div className="col-span-2">
            <label className="erp-label block">Delivery Days</label>
            <input type="number" value={deliveryDays}
                   onChange={e => setDeliveryDays(Number(e.target.value))}
                   className="erp-input w-full font-mono" />
          </div>
          <div className="col-span-2">
            <label className="erp-label block">Payment Terms</label>
            <input value={paymentTerms} onChange={e => setPaymentTerms(e.target.value)}
                   className="erp-input w-full" />
          </div>
        </div>

        <div className="bg-white rounded border border-[#b8c9dd] overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-200">
            <span className="font-bold text-blue-900">Order lines</span>
            <button onClick={addLine} className="erp-btn ml-auto">
              <Plus className="w-3.5 h-3.5 text-emerald-600" /><span>Add Line</span>
            </button>
          </div>
          <table className="w-full">
            <thead className="bg-slate-100 border-b border-slate-300 text-left">
              <tr>
                <th className="px-2 py-1.5 font-bold">Quality</th>
                <th className="px-2 py-1.5 font-bold">Grade</th>
                <th className="px-2 py-1.5 font-bold text-right">Pcs</th>
                <th className="px-2 py-1.5 font-bold text-right">Cut</th>
                <th className="px-2 py-1.5 font-bold text-right">Qty</th>
                <th className="px-2 py-1.5 font-bold text-right">Rate</th>
                <th className="px-2 py-1.5 font-bold text-right">Amount</th>
                <th className="px-2 py-1.5"></th>
              </tr>
            </thead>
            <tbody>
              {lines.length === 0 && (
                <tr><td colSpan={8} className="px-2 py-5 text-center text-slate-400">Add a line</td></tr>
              )}
              {lines.map((l, i) => (
                <tr key={i} className="border-b border-slate-100">
                  <td className="px-2 py-1">
                    <select value={l.qualityId} onChange={e => update(i, { qualityId: e.target.value })}
                            className="erp-input w-40">
                      {(qualities.data ?? []).map(q => <option key={q.id} value={q.id}>{q.name}</option>)}
                    </select>
                  </td>
                  <td className="px-2 py-1">
                    <select value={l.gradeCode} onChange={e => update(i, { gradeCode: e.target.value })}
                            className="erp-input w-28">
                      {(grades.data ?? []).map(g => <option key={g.code} value={g.code}>{g.name}</option>)}
                    </select>
                  </td>
                  <td className="px-2 py-1 text-right">
                    <input type="number" value={l.pcs} onChange={e => update(i, { pcs: Number(e.target.value) })}
                           className="erp-input w-20 text-right font-mono" />
                  </td>
                  <td className="px-2 py-1 text-right">
                    <input type="number" step="0.01" value={l.cutLength}
                           onChange={e => update(i, { cutLength: Number(e.target.value) })}
                           className="erp-input w-20 text-right font-mono" />
                  </td>
                  <td className="px-2 py-1 text-right font-mono">{lineQty(l).toFixed(2)}</td>
                  <td className="px-2 py-1 text-right">
                    <input type="number" step="0.01" value={l.rate}
                           onChange={e => update(i, { rate: Number(e.target.value) })}
                           className="erp-input w-20 text-right font-mono" />
                  </td>
                  <td className="px-2 py-1 text-right font-mono">{money(lineQty(l) * l.rate)}</td>
                  <td className="px-2 py-1 text-right">
                    <button onClick={() => setLines(p => p.filter((_, j) => j !== i))}
                            title="Remove line" className="text-red-600 hover:text-red-800">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="bg-slate-50 border-t border-slate-300 px-3 py-2 flex items-center justify-end gap-6 font-bold">
            <span>Order value: {money(total)}</span>
            <button onClick={save} disabled={busy}
                    className="erp-btn erp-btn-primary font-bold disabled:opacity-60">
              {busy ? 'Booking…' : 'Book Order'}
            </button>
          </div>
        </div>

        <div className="bg-white rounded border border-[#b8c9dd] overflow-hidden">
          <header className="px-3 py-2 border-b border-slate-200 font-bold text-blue-900">
            Open orders
          </header>
          <ListControls list={orders} placeholder="Order no, party or destination…" />
          <table className="w-full">
            <thead className="bg-slate-100 border-b border-slate-300 text-left">
              <tr>
                <th className="px-2 py-1.5 font-bold">Order</th>
                <th className="px-2 py-1.5 font-bold">Date</th>
                <th className="px-2 py-1.5 font-bold">Customer</th>
                <th className="px-2 py-1.5 font-bold">Destination</th>
                <th className="px-2 py-1.5 font-bold">Quality</th>
                <th className="px-2 py-1.5 font-bold text-right">Ordered</th>
                <th className="px-2 py-1.5 font-bold text-right">Dispatched</th>
                <th className="px-2 py-1.5 font-bold text-right">Balance</th>
                <th className="px-2 py-1.5 font-bold text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {orders.rows.flatMap(o =>
                o.lines.map(l => (
                  <tr key={`${o.id}-${l.sno}`} className="border-b border-slate-100">
                    <td className="px-2 py-1 font-mono text-blue-800">{o.order_no}</td>
                    <td className="px-2 py-1">{o.order_date}</td>
                    <td className="px-2 py-1">{o.party_name}</td>
                    <td className="px-2 py-1">{o.destination}</td>
                    <td className="px-2 py-1">{l.quality}</td>
                    <td className="px-2 py-1 text-right font-mono">{Number(l.qty).toFixed(2)}</td>
                    <td className="px-2 py-1 text-right font-mono">{Number(l.dispatched_qty).toFixed(2)}</td>
                    <td className="px-2 py-1 text-right font-mono font-bold">
                      {(Number(l.qty) - Number(l.dispatched_qty)).toFixed(2)}
                    </td>
                    <td className="px-2 py-1 text-right font-mono">{money(Number(l.amount))}</td>
                  </tr>
                ))
              )}
              {!orders.loading && orders.rows.length === 0 && (
                <tr><td colSpan={9} className="px-2 py-5 text-center text-slate-400">
                  No orders booked
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
