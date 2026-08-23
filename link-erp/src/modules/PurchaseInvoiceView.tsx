import React, { useState } from 'react';
import { ToolbarRibbon } from '../components/ToolbarRibbon';
import { usePagedList } from '../lib/usePagedList';
import { ListControls } from '../components/ListControls';
import { useApi, useSubmit } from '../lib/useApi';
import type { HsnRow, LedgerRow } from '../lib/api';
import { AlertTriangle, CheckCircle2, Plus, Trash2 } from 'lucide-react';

interface Line { hsnCode: string; description: string; qty: number; rate: number; gstRate: number }

interface PurchaseRow {
  id: string; our_ref: string; supplier_invoice_no: string; invoice_date: string;
  party_name: string; supply_type: string; is_rcm: boolean;
  taxable_value: number; cgst_amount: number; sgst_amount: number; igst_amount: number;
  invoice_total: number; itc_eligible: boolean;
}

const money = (v: number) => `₹${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
const today = () => new Date().toISOString().slice(0, 10);

/** Inward tax. Without it the mill sees what it owes but not what it can claim. */
export const PurchaseInvoiceView: React.FC = () => {
  const [partyId, setPartyId] = useState('');
  const [supplierInvoiceNo, setSupplierInvoiceNo] = useState('');
  const [invoiceDate, setInvoiceDate] = useState(today());
  const [kind, setKind] = useState<'grey' | 'jobwork'>('grey');
  const [itcEligible, setItcEligible] = useState(true);
  const [lines, setLines] = useState<Line[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  const ledgers = useApi<LedgerRow[]>('/ledgers');
  const hsn = useApi<HsnRow[]>('/hsn-codes');
  const invoices = usePagedList<PurchaseRow>('/purchase-invoices', 50, 'purchase_invoices');
  const { submit, busy, error } = useSubmit<unknown, any>('/purchase-invoices');

  const addLine = () => {
    const h = hsn.data?.[0];
    if (!h) return;
    setLines(prev => [...prev, {
      hsnCode: h.code, description: '', qty: 100, rate: 30.5, gstRate: Number(h.gst_rate)
    }]);
  };

  const update = (i: number, patch: Partial<Line>) =>
    setLines(prev => prev.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const taxable = lines.reduce((n, l) => n + l.qty * l.rate, 0);

  const save = async () => {
    if (!partyId || !supplierInvoiceNo || lines.length === 0) {
      setNotice('pick a supplier, enter their invoice number, add a line');
      return;
    }
    const out = await submit({
      partyId, supplierInvoiceNo, invoiceDate, kind, itcEligible, lines
    });
    if (out) {
      setNotice(
        `${out.ourRef} booked — taxable ${money(out.taxableValue)}, total ${money(out.invoiceTotal)}` +
        (out.isRcm ? ` (reverse charge, ${money(out.itcClaimed)} self-assessed)` : '') +
        `, input credit ${money(out.itcClaimed)}`
      );
      setLines([]);
      setSupplierInvoiceNo('');
      invoices.reload();
    }
  };

  return (
    <div className="flex flex-col h-full bg-[#ecf1f7] text-slate-800 text-xs">
      <ToolbarRibbon
        title="Purchase Invoice (Inward GST)"
        onSave={save}
        onNew={() => { setLines([]); setSupplierInvoiceNo(''); setNotice(null); }}
        onExport={() => void invoices.exportCsv()}
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
        <div className="bg-white rounded border border-[#b8c9dd] p-3 grid grid-cols-1 md:grid-cols-12 gap-2.5">
          <div className="md:col-span-4">
            <label htmlFor="purchase-supplier" className="erp-label block text-red-700 font-bold">* Supplier</label>
            <select id="purchase-supplier" value={partyId} onChange={e => setPartyId(e.target.value)} className="erp-input w-full">
              <option value="">— select —</option>
              {(ledgers.data ?? []).map(l => (
                <option key={l.id} value={l.id}>{l.name}{l.gstin ? '' : ' (unregistered — RCM)'}</option>
              ))}
            </select>
          </div>
          <div className="md:col-span-3">
            <label htmlFor="purchase-invoice-no" className="erp-label block text-red-700 font-bold">* Their Invoice No.</label>
            <input id="purchase-invoice-no" value={supplierInvoiceNo} onChange={e => setSupplierInvoiceNo(e.target.value)}
                   className="erp-input w-full font-mono" />
          </div>
          <div className="md:col-span-2">
            <label htmlFor="purchase-invoice-date" className="erp-label block">Invoice Date</label>
            <input id="purchase-invoice-date" type="date" value={invoiceDate} onChange={e => setInvoiceDate(e.target.value)}
                   className="erp-input w-full" />
          </div>
          <div className="md:col-span-2">
            <label htmlFor="purchase-nature" className="erp-label block">Nature</label>
            <select id="purchase-nature" value={kind} onChange={e => setKind(e.target.value as 'grey' | 'jobwork')}
                    className="erp-input w-full">
              <option value="grey">Grey purchase</option>
              <option value="jobwork">Jobwork / processing</option>
            </select>
          </div>
          <div className="md:col-span-1 flex items-end">
            <label className="flex items-center gap-1.5 cursor-pointer font-medium pb-1">
              <input type="checkbox" checked={itcEligible}
                     onChange={e => setItcEligible(e.target.checked)} className="w-4 h-4 rounded" />
              <span>ITC</span>
            </label>
          </div>
        </div>

        <div className="bg-white rounded border border-[#b8c9dd] overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-200">
            <span className="font-bold text-blue-900">Lines</span>
            <button onClick={addLine} className="erp-btn ml-auto">
              <Plus className="w-3.5 h-3.5 text-emerald-600" /><span>Add Line</span>
            </button>
          </div>
          <table className="w-full">
            <thead className="bg-slate-100 border-b border-slate-300 text-left">
              <tr>
                <th className="px-2 py-1.5 font-bold">HSN</th>
                <th className="px-2 py-1.5 font-bold">Description</th>
                <th className="px-2 py-1.5 font-bold text-right">Qty</th>
                <th className="px-2 py-1.5 font-bold text-right">Rate</th>
                <th className="px-2 py-1.5 font-bold text-right">GST %</th>
                <th className="px-2 py-1.5 font-bold text-right">Taxable</th>
                <th className="px-2 py-1.5"></th>
              </tr>
            </thead>
            <tbody>
              {lines.length === 0 && (
                <tr><td colSpan={7} className="px-2 py-5 text-center text-slate-400">Add a line</td></tr>
              )}
              {lines.map((l, i) => (
                <tr key={i} className="border-b border-slate-100">
                  <td className="px-2 py-1">
                    <select aria-label={`HSN for purchase line ${i + 1}`} value={l.hsnCode}
                            onChange={e => {
                              const h = (hsn.data ?? []).find(x => x.code === e.target.value);
                              update(i, { hsnCode: e.target.value, gstRate: Number(h?.gst_rate ?? l.gstRate) });
                            }}
                            className="erp-input w-28 font-mono">
                      {(hsn.data ?? []).map(h => <option key={h.code} value={h.code}>{h.code}</option>)}
                    </select>
                  </td>
                  <td className="px-2 py-1">
                    <input aria-label={`Description for purchase line ${i + 1}`} value={l.description} onChange={e => update(i, { description: e.target.value })}
                           className="erp-input w-full" placeholder="what was bought" />
                  </td>
                  <td className="px-2 py-1 text-right">
                    <input aria-label={`Quantity for purchase line ${i + 1}`} type="number" step="0.01" value={l.qty}
                           onChange={e => update(i, { qty: Number(e.target.value) })}
                           className="erp-input w-24 text-right font-mono" />
                  </td>
                  <td className="px-2 py-1 text-right">
                    <input aria-label={`Rate for purchase line ${i + 1}`} type="number" step="0.01" value={l.rate}
                           onChange={e => update(i, { rate: Number(e.target.value) })}
                           className="erp-input w-24 text-right font-mono" />
                  </td>
                  <td className="px-2 py-1 text-right font-mono">{l.gstRate}</td>
                  <td className="px-2 py-1 text-right font-mono">{money(l.qty * l.rate)}</td>
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
            <span>Taxable: {money(taxable)}</span>
            <button onClick={save} disabled={busy}
                    className="erp-btn erp-btn-primary font-bold disabled:opacity-60">
              {busy ? 'Booking…' : 'Book Invoice'}
            </button>
          </div>
        </div>

        <div className="bg-white rounded border border-[#b8c9dd] overflow-hidden">
          <header className="px-3 py-2 border-b border-slate-200 font-bold text-blue-900">
            Booked purchase invoices
          </header>
          <ListControls list={invoices} placeholder="Our ref, supplier bill or party…" />
          <table className="w-full">
            <thead className="bg-slate-100 border-b border-slate-300 text-left">
              <tr>
                <th className="px-2 py-1.5 font-bold">Our Ref</th>
                <th className="px-2 py-1.5 font-bold">Their Invoice</th>
                <th className="px-2 py-1.5 font-bold">Date</th>
                <th className="px-2 py-1.5 font-bold">Supplier</th>
                <th className="px-2 py-1.5 font-bold">RCM</th>
                <th className="px-2 py-1.5 font-bold text-right">Taxable</th>
                <th className="px-2 py-1.5 font-bold text-right">CGST</th>
                <th className="px-2 py-1.5 font-bold text-right">SGST</th>
                <th className="px-2 py-1.5 font-bold text-right">IGST</th>
                <th className="px-2 py-1.5 font-bold text-right">Total</th>
                <th className="px-2 py-1.5 font-bold">ITC</th>
              </tr>
            </thead>
            <tbody>
              {invoices.rows.map(p => (
                <tr key={p.id} className="border-b border-slate-100">
                  <td className="px-2 py-1 font-mono text-blue-800">{p.our_ref}</td>
                  <td className="px-2 py-1 font-mono">{p.supplier_invoice_no}</td>
                  <td className="px-2 py-1">{p.invoice_date}</td>
                  <td className="px-2 py-1">{p.party_name}</td>
                  <td className="px-2 py-1">{p.is_rcm ? 'Yes' : ''}</td>
                  <td className="px-2 py-1 text-right font-mono">{money(p.taxable_value)}</td>
                  <td className="px-2 py-1 text-right font-mono">{money(p.cgst_amount)}</td>
                  <td className="px-2 py-1 text-right font-mono">{money(p.sgst_amount)}</td>
                  <td className="px-2 py-1 text-right font-mono">{money(p.igst_amount)}</td>
                  <td className="px-2 py-1 text-right font-mono font-bold">{money(p.invoice_total)}</td>
                  <td className="px-2 py-1">{p.itc_eligible ? 'Eligible' : 'Blocked'}</td>
                </tr>
              ))}
              {!invoices.loading && invoices.rows.length === 0 && (
                <tr><td colSpan={11} className="px-2 py-5 text-center text-slate-400">
                  Nothing booked yet
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
