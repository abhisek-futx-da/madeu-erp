import React, { useState } from 'react';
import { ToolbarRibbon } from '../components/ToolbarRibbon';
import { usePagedList } from '../lib/usePagedList';
import { ListControls } from '../components/ListControls';
import { useApi, useSubmit } from '../lib/useApi';
import { api, type Page } from '../lib/api';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';

interface InvoiceRow {
  id: string; invoice_no: string; invoice_date: string; party_name: string;
  taxable_value: number; invoice_total: number; supply_type: string;
}

interface NoteRow {
  id: string; note_no: string; note_kind: 'credit' | 'debit'; note_date: string;
  reason: string; against_invoice: string; party_name: string;
  taxable_value: number; cgst_amount: number; sgst_amount: number;
  igst_amount: number; note_total: number;
  status: string;
}

const money = (v: number) => `₹${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
const today = () => new Date().toISOString().slice(0, 10);

/** Credit and debit notes against an issued tax invoice. */
export const GstNoteView: React.FC = () => {
  const [kind, setKind] = useState<'credit' | 'debit'>('credit');
  const [againstInvoiceId, setAgainstInvoiceId] = useState('');
  const [noteDate, setNoteDate] = useState(today());
  const [reason, setReason] = useState('');
  const [taxableValue, setTaxableValue] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);

  const invoices = useApi<Page<InvoiceRow>>('/sales-invoices?limit=200');
  const notes = usePagedList<NoteRow>('/gst-notes');
  const { submit, busy, error } = useSubmit<unknown, any>('/gst-notes');
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  const selected = (invoices.data?.rows ?? []).find(i => i.id === againstInvoiceId);

  const save = async () => {
    if (!againstInvoiceId || !reason || taxableValue <= 0) {
      setNotice('pick an invoice, give a reason, and enter a value');
      return;
    }
    const out = await submit({ kind, againstInvoiceId, noteDate, reason, taxableValue });
    if (out) {
      setNotice(`${out.noteNo} raised — ${money(out.taxableValue)} plus tax, total ${money(out.noteTotal)}`);
      setReason('');
      setTaxableValue(0);
      notes.reload();
    }
  };

  const cancel = async (note: NoteRow) => {
    if (!window.confirm(`Cancel ${note.note_no}? This reverses the accounting voucher and removes it from GST reports.`)) return;
    const reason = window.prompt('Reason for cancellation (required)')?.trim();
    if (!reason) return;
    setCancellingId(note.id);
    try {
      await api.post(`/documents/gst_note/${note.id}/cancel`, { reason });
      setNotice(`${note.note_no} cancelled; its accounting and GST effect were reversed`);
      notes.reload();
    } catch (e: any) {
      setNotice(e.message || String(e));
    } finally {
      setCancellingId(null);
    }
  };

  return (
    <div className="flex flex-col h-full bg-[#ecf1f7] text-slate-800 text-xs">
      <ToolbarRibbon
        title="Credit / Debit Notes"
        onSave={save}
        onNew={() => { setReason(''); setTaxableValue(0); setNotice(null); }}
        onExport={() => void notes.exportCsv()}
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
          <div className="col-span-2">
            <label className="erp-label block text-red-700 font-bold">* Note Type</label>
            <select value={kind} onChange={e => setKind(e.target.value as 'credit' | 'debit')}
                    className="erp-input w-full">
              <option value="credit">Credit note (reduces the sale)</option>
              <option value="debit">Debit note (adds to the sale)</option>
            </select>
          </div>
          <div className="col-span-4">
            <label className="erp-label block text-red-700 font-bold">* Against Invoice</label>
            <select value={againstInvoiceId} onChange={e => setAgainstInvoiceId(e.target.value)}
                    className="erp-input w-full">
              <option value="">— select —</option>
              {(invoices.data?.rows ?? []).map(i => (
                <option key={i.id} value={i.id}>
                  {i.invoice_no} — {i.party_name} — {money(i.taxable_value)}
                </option>
              ))}
            </select>
          </div>
          <div className="col-span-2">
            <label className="erp-label block">Note Date</label>
            <input type="date" value={noteDate} onChange={e => setNoteDate(e.target.value)}
                   className="erp-input w-full" />
          </div>
          <div className="col-span-2">
            <label className="erp-label block text-red-700 font-bold">* Taxable Value</label>
            <input type="number" step="0.01" value={taxableValue}
                   onChange={e => setTaxableValue(Number(e.target.value))}
                   className="erp-input w-full text-right font-mono" />
            {selected && (
              <p className="text-[10px] text-slate-500 mt-0.5">
                invoice is {money(selected.taxable_value)}
              </p>
            )}
          </div>
          <div className="col-span-2">
            <label className="erp-label block text-red-700 font-bold">* Reason</label>
            <input value={reason} onChange={e => setReason(e.target.value)}
                   className="erp-input w-full" placeholder="shade variation" />
          </div>
        </div>

        <div className="flex justify-end">
          <button onClick={save} disabled={busy}
                  className="erp-btn erp-btn-primary font-bold px-5 disabled:opacity-60">
            {busy ? 'Raising…' : `Raise ${kind === 'credit' ? 'Credit' : 'Debit'} Note`}
          </button>
        </div>

        <div className="bg-white rounded border border-[#b8c9dd] overflow-hidden">
          <header className="px-3 py-2 border-b border-slate-200 font-bold text-blue-900">
            Notes raised
          </header>
          <ListControls list={notes} placeholder="Note no, invoice or party…" />
          <table className="w-full">
            <thead className="bg-slate-100 border-b border-slate-300 text-left">
              <tr>
                <th className="px-2 py-1.5 font-bold">Note</th>
                <th className="px-2 py-1.5 font-bold">Type</th>
                <th className="px-2 py-1.5 font-bold">Status</th>
                <th className="px-2 py-1.5 font-bold">Date</th>
                <th className="px-2 py-1.5 font-bold">Against</th>
                <th className="px-2 py-1.5 font-bold">Party</th>
                <th className="px-2 py-1.5 font-bold">Reason</th>
                <th className="px-2 py-1.5 font-bold text-right">Taxable</th>
                <th className="px-2 py-1.5 font-bold text-right">CGST</th>
                <th className="px-2 py-1.5 font-bold text-right">SGST</th>
                <th className="px-2 py-1.5 font-bold text-right">IGST</th>
                <th className="px-2 py-1.5 font-bold text-right">Total</th>
                <th className="px-2 py-1.5 font-bold"></th>
              </tr>
            </thead>
            <tbody>
              {notes.rows.map(n => (
                <tr key={n.id} className="border-b border-slate-100">
                  <td className="px-2 py-1 font-mono text-blue-800">{n.note_no}</td>
                  <td className="px-2 py-1">
                    <span className={`px-1.5 py-0.5 rounded border font-semibold ${
                      n.note_kind === 'credit'
                        ? 'bg-red-50 border-red-300 text-red-800'
                        : 'bg-emerald-50 border-emerald-300 text-emerald-800'
                    }`}>
                      {n.note_kind}
                    </span>
                  </td>
                  <td className="px-2 py-1 capitalize">{n.status}</td>
                  <td className="px-2 py-1">{n.note_date}</td>
                  <td className="px-2 py-1 font-mono">{n.against_invoice}</td>
                  <td className="px-2 py-1">{n.party_name}</td>
                  <td className="px-2 py-1">{n.reason}</td>
                  <td className="px-2 py-1 text-right font-mono">{money(n.taxable_value)}</td>
                  <td className="px-2 py-1 text-right font-mono">{money(n.cgst_amount)}</td>
                  <td className="px-2 py-1 text-right font-mono">{money(n.sgst_amount)}</td>
                  <td className="px-2 py-1 text-right font-mono">{money(n.igst_amount)}</td>
                  <td className="px-2 py-1 text-right font-mono font-bold">{money(n.note_total)}</td>
                  <td className="px-2 py-1 text-right">
                    {n.status !== 'cancelled' && (
                      <button onClick={() => void cancel(n)} disabled={cancellingId === n.id}
                              className="text-red-700 hover:text-red-900 disabled:opacity-50">
                        {cancellingId === n.id ? 'Cancelling…' : 'Cancel'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {!notes.loading && notes.rows.length === 0 && (
                <tr><td colSpan={13} className="px-2 py-5 text-center text-slate-400">
                  No notes raised
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
