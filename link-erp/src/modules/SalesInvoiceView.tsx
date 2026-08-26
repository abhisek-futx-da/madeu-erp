import React, { useState } from 'react';
import { ToolbarRibbon } from '../components/ToolbarRibbon';
import { useApi, useSubmit } from '../lib/useApi';
import { usePagedList } from '../lib/usePagedList';
import { ListControls } from '../components/ListControls';
import { api, type Page } from '../lib/api';
import { AlertTriangle, CheckCircle2, Download, FileJson, Paperclip, Printer, Receipt, Settings2, Truck, X } from 'lucide-react';
import { InvoicePrintView } from './InvoicePrintView';
import { DocumentAttachments } from '../components/DocumentAttachments';
import { CustomFieldsPanel } from '../components/CustomFieldsPanel';
import type { Session } from '../lib/api';

interface InvoiceRow {
  id: string; invoice_no: string; invoice_date: string;
  place_of_supply: string; supply_type: string;
  taxable_value: number; cgst_amount: number; sgst_amount: number;
  igst_amount: number; round_off: number; invoice_total: number;
  party_name: string; gstin: string | null; brokerage_amount: number;
  broker_name: string | null; brokerage_state: 'none' | 'accrued' | 'released' | 'forfeited';
  filing_status: string | null; irn: string | null; last_error: string | null;
  ewb_no: string | null; ewb_ref: string | null;
}

interface DispatchRow {
  id: string; challan_no: string; challan_date: string;
  party_name: string; pieces: number; value: number;
}

const money = (v: number | null) =>
  v == null ? '' : `₹${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

const SUPPLY_LABEL: Record<string, string> = {
  intra_state: 'Intra-state (CGST+SGST)',
  inter_state: 'Inter-state (IGST)',
  export: 'Export (zero-rated)',
  sez: 'SEZ (zero-rated)'
};

/** Tax invoices raised against dispatches, and their IRP readiness. */
export const SalesInvoiceView: React.FC<{ session: Session }> = ({ session }) => {
  const invoices = usePagedList<InvoiceRow>('/sales-invoices', 50, 'sales_invoices');
  const uninvoiced = useApi<Page<DispatchRow>>('/dispatches?uninvoiced=true&limit=100');
  const { submit, busy, error } = useSubmit<unknown, any>('/sales-invoices');

  const [notice, setNotice] = useState<string | null>(null);
  const [payload, setPayload] = useState<{ no: string; json: unknown } | null>(null);
  const [printing, setPrinting] = useState<string | null>(null);
  const [distance, setDistance] = useState(500);
  const [ewayFor, setEwayFor] = useState<InvoiceRow | null>(null);
  const [attachmentFor,setAttachmentFor]=useState<InvoiceRow|null>(null);
  const [customFor,setCustomFor]=useState<InvoiceRow|null>(null);

  const raise = async (dispatchId: string) => {
    const out = await submit({ dispatchId, distanceKm: distance });
    if (out) {
      setNotice(
        `Invoice ${out.invoiceNo}: ${SUPPLY_LABEL[out.supplyType]}, taxable ${money(out.taxableValue)}, ` +
        `total ${money(out.invoiceTotal)}` +
        (out.brokerage > 0 ? `; brokerage accrued ${money(out.brokerage)}` : '') +
        (out.einvoiceReady ? ' — e-invoice payload ready' : ` — payload blocked: ${out.einvoiceIssues.map((i: any) => i.field).join(', ')}`)
      );
      invoices.reload();
      uninvoiced.reload();
    }
  };

  const showPayload = async (row: InvoiceRow) => {
    const doc = await api.get<{ payload: unknown }>(`/sales-invoices/${row.id}/einvoice`);
    setPayload({ no: row.invoice_no, json: doc.payload });
  };

  /** Rule 138 Part A for the consignment this invoice covers. */
  const raiseEway = async (row: InvoiceRow) => {
    setEwayFor(row);
    try {
      const out = await api.post<any>(`/eway-bills/invoice/${row.id}`, {
        distanceKm: distance, vehicleNo: prompt('Vehicle number (leave blank if a transporter carries it)') || null
      });
      setNotice(out.ok
        ? `E-way bill ${out.ewayBill.ourRef} prepared — valid ${out.ewayBill.validityDays} day(s), to ${out.ewayBill.validUntil}`
        : `E-way bill blocked: ${out.issues.map((i: any) => `${i.field} ${i.problem}`).join('; ')}`);
      invoices.reload();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setEwayFor(null);
    }
  };

  const forfeit = async (row: InvoiceRow) => {
    const reason = prompt(`Why is brokerage on ${row.invoice_no} being forfeited?`);
    if (!reason?.trim()) return;
    try {
      await api.post(`/sales-invoices/${row.id}/brokerage/forfeit`, { reason: reason.trim() });
      setNotice(`${row.invoice_no}: brokerage forfeited and the accrual was reversed`);
      invoices.reload();
    } catch (e) { setNotice(e instanceof Error ? e.message : String(e)); }
  };

  return (
    <div className="flex flex-col h-full bg-[#ecf1f7] text-slate-800 text-xs">
      <ToolbarRibbon
        title="Tax Invoices (GST)"
        actions={[
          { key: 'find', onRun: () => document.querySelector<HTMLInputElement>('input[placeholder^="Invoice"]')?.focus() },
          { key: 'export', onRun: () => void invoices.exportCsv() },
          { key: 'print', onRun: () => window.print() }
        ]}
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
        <section className="bg-white rounded border border-[#b8c9dd]">
          <header className="px-3 py-2 border-b border-slate-200 flex items-center gap-2">
            <Receipt className="w-4 h-4 text-blue-700" />
            <span className="font-bold text-blue-900">Dispatches awaiting a tax invoice</span>
            <label className="ml-auto flex items-center gap-1.5" htmlFor="dist">
              <span>E-way distance (km)</span>
              <input
                id="dist" type="number" min={1} max={4000} value={distance}
                onChange={e => setDistance(Number(e.target.value))}
                className="erp-input w-24 font-mono"
              />
            </label>
          </header>
          <table className="w-full">
            <thead className="bg-slate-100 border-b border-slate-300 text-left">
              <tr>
                <th className="px-2 py-1.5 font-bold">Challan</th>
                <th className="px-2 py-1.5 font-bold">Date</th>
                <th className="px-2 py-1.5 font-bold">Party</th>
                <th className="px-2 py-1.5 font-bold text-right">Pieces</th>
                <th className="px-2 py-1.5 font-bold text-right">Value</th>
                <th className="px-2 py-1.5"></th>
              </tr>
            </thead>
            <tbody>
              {(uninvoiced.data?.rows ?? []).length === 0 && (
                <tr><td colSpan={6} className="px-2 py-5 text-center text-slate-400">
                  Every dispatch has been invoiced
                </td></tr>
              )}
              {(uninvoiced.data?.rows ?? []).map(d => (
                <tr key={d.id} className="border-b border-slate-100">
                  <td className="px-2 py-1 font-mono">{d.challan_no}</td>
                  <td className="px-2 py-1">{d.challan_date}</td>
                  <td className="px-2 py-1">{d.party_name}</td>
                  <td className="px-2 py-1 text-right font-mono">{d.pieces}</td>
                  <td className="px-2 py-1 text-right font-mono">{money(d.value)}</td>
                  <td className="px-2 py-1 text-right">
                    <button onClick={() => raise(d.id)} disabled={busy}
                            className="erp-btn erp-btn-primary font-bold disabled:opacity-60">
                      {busy ? 'Raising…' : 'Raise Invoice'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="bg-white rounded border border-[#b8c9dd]">
          <header className="px-3 py-2 border-b border-slate-200 font-bold text-blue-900">
            Raised invoices
          </header>
          <ListControls list={invoices} placeholder="Invoice no, party or GSTIN…" />
          <table className="w-full">
            <thead className="bg-slate-100 border-b border-slate-300 text-left">
              <tr>
                <th className="px-2 py-1.5 font-bold">Invoice</th>
                <th className="px-2 py-1.5 font-bold">Date</th>
                <th className="px-2 py-1.5 font-bold">Party</th>
                <th className="px-2 py-1.5 font-bold">Supply</th>
                <th className="px-2 py-1.5 font-bold">POS</th>
                <th className="px-2 py-1.5 font-bold text-right">Taxable</th>
                <th className="px-2 py-1.5 font-bold text-right">CGST</th>
                <th className="px-2 py-1.5 font-bold text-right">SGST</th>
                <th className="px-2 py-1.5 font-bold text-right">IGST</th>
                <th className="px-2 py-1.5 font-bold text-right">Total</th>
                <th className="px-2 py-1.5 font-bold text-right">Brokerage</th>
                <th className="px-2 py-1.5 font-bold">IRP</th>
                <th className="px-2 py-1.5"></th>
              </tr>
            </thead>
            <tbody>
              {invoices.rows.map(i => (
                <tr key={i.id} className="border-b border-slate-100 hover:bg-blue-50/40">
                  <td className="px-2 py-1 font-mono text-blue-800">{i.invoice_no}</td>
                  <td className="px-2 py-1">{i.invoice_date}</td>
                  <td className="px-2 py-1">{i.party_name}</td>
                  <td className="px-2 py-1">{SUPPLY_LABEL[i.supply_type] ?? i.supply_type}</td>
                  <td className="px-2 py-1 font-mono">{i.place_of_supply}</td>
                  <td className="px-2 py-1 text-right font-mono">{money(i.taxable_value)}</td>
                  <td className="px-2 py-1 text-right font-mono">{money(i.cgst_amount)}</td>
                  <td className="px-2 py-1 text-right font-mono">{money(i.sgst_amount)}</td>
                  <td className="px-2 py-1 text-right font-mono">{money(i.igst_amount)}</td>
                  <td className="px-2 py-1 text-right font-mono font-bold">{money(i.invoice_total)}</td>
                  <td className="px-2 py-1 text-right font-mono" title={i.broker_name ?? undefined}>{i.brokerage_amount > 0
                    ? <><span>{money(i.brokerage_amount)}</span><span className="block text-[10px] uppercase">{i.brokerage_state}</span></>
                    : '—'}</td>
                  <td className="px-2 py-1">
                    <span className={`px-1.5 py-0.5 rounded border font-semibold ${
                      i.irn ? 'bg-emerald-50 border-emerald-300 text-emerald-800'
                        : i.filing_status === 'ready' ? 'bg-blue-50 border-blue-300 text-blue-800'
                        : 'bg-amber-50 border-amber-300 text-amber-900'
                    }`} title={i.last_error ?? undefined}>
                      {i.irn ? 'IRN issued' : i.filing_status ?? 'not built'}
                    </span>
                  </td>
                  <td className="px-2 py-1 text-right">
                    <button onClick={() => setPrinting(i.id)} className="erp-btn" title="Print invoice">
                      <Printer className="w-3.5 h-3.5 text-blue-700" />
                    </button>
                    <button onClick={() => void api.download(`/sales-invoices/${i.id}/pdf`, `${i.invoice_no}.pdf`)}
                      className="erp-btn" title="Download invoice, LR and packing list PDF">
                      <Download className="w-3.5 h-3.5 text-blue-700" />
                    </button>
                    <button onClick={() => showPayload(i)} className="erp-btn" title="View IRP payload">
                      <FileJson className="w-3.5 h-3.5 text-blue-600" />
                    </button>
                    <button onClick={()=>setAttachmentFor(i)} className="erp-btn" title="Attach signed invoice, LR or customer evidence"><Paperclip className="h-3.5 w-3.5 text-blue-700"/></button>
                    <button onClick={()=>setCustomFor(i)} className="erp-btn" title="Edit custom invoice fields"><Settings2 className="h-3.5 w-3.5 text-violet-700"/></button>
                    <button onClick={() => raiseEway(i)} disabled={ewayFor?.id === i.id}
                      className="erp-btn disabled:opacity-40"
                      title={i.ewb_no ? `E-way bill ${i.ewb_no}` : i.ewb_ref ? `E-way bill ${i.ewb_ref} prepared` : 'Prepare e-way bill (Rule 138)'}>
                      <Truck className={`w-3.5 h-3.5 ${i.ewb_ref ? 'text-emerald-600' : 'text-slate-500'}`} />
                    </button>
                    {session.role === 'owner' && i.brokerage_state === 'accrued' && <button
                      onClick={() => void forfeit(i)} className="erp-btn text-red-700" title="Forfeit unpaid brokerage">
                      Forfeit
                    </button>}
                  </td>
                </tr>
              ))}
              {!invoices.loading && invoices.rows.length === 0 && (
                <tr><td colSpan={13} className="px-2 py-6 text-center text-slate-400">
                  No invoices raised yet
                </td></tr>
              )}
            </tbody>
          </table>
        </section>
      </div>

      {printing && (
        <InvoicePrintView invoiceId={printing} session={session} onClose={() => setPrinting(null)} />
      )}
      {attachmentFor&&<DocumentAttachments docType="sales_invoice" docId={attachmentFor.id} label={attachmentFor.invoice_no} onClose={()=>setAttachmentFor(null)}/>}
      {customFor&&<CustomFieldsPanel entityType="sales_invoice" entityId={customFor.id} label={customFor.invoice_no} onClose={()=>setCustomFor(null)}/>}

      {payload && (
        <div className="absolute inset-0 bg-black/40 flex items-center justify-center p-8 z-50">
          <div className="bg-white rounded border border-slate-400 shadow-xl w-full max-w-3xl max-h-full flex flex-col">
            <header className="px-3 py-2 bg-blue-800 text-white flex items-center gap-2">
              <FileJson className="w-4 h-4" />
              <span className="font-bold">IRP payload — {payload.no}</span>
              <button onClick={() => setPayload(null)} className="ml-auto" title="Close">
                <X className="w-4 h-4" />
              </button>
            </header>
            <pre className="p-3 overflow-auto font-mono text-[11px] leading-relaxed">
              {JSON.stringify(payload.json, null, 2)}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
};
