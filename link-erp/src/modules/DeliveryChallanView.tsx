import { useState } from 'react';
import { Truck, Printer, AlertTriangle, CheckCircle2, X } from 'lucide-react';
import { ToolbarRibbon } from '../components/ToolbarRibbon';
import { ListControls } from '../components/ListControls';
import { usePagedList } from '../lib/usePagedList';
import { useApi } from '../lib/useApi';
import { api } from '../lib/api';

/**
 * The Rule 55 delivery challan that goes out with grey to a dyeing house, and
 * the Rule 138 e-way bill that has to travel with it. This is the movement a
 * processing mill makes every day and the system had no document for.
 */

interface ChallanRow {
  issue_id: string; entry_no: string; challan_no: string; challan_date: string;
  lot_no: string; consignee_name: string; consignee_gstin: string | null;
  pieces: number; total_qty: number; taxable_value: number;
  vehicle_no: string | null; status: string;
  ewb_no: string | null; ewb_ref: string | null; ewb_valid_until: string | null;
}

interface PrintDoc {
  challan_no: string; challan_date: string; lot_no: string; no_of_bales: number;
  consignor_name: string; consignor_gstin: string; consignor_addr: string;
  consignor_city: string; consignor_pincode: string; consignor_state: string;
  consignee_name: string; consignee_gstin: string | null; consignee_addr: string | null;
  consignee_city: string | null; consignee_pincode: string | null; consignee_state: string | null;
  vehicle_no: string | null; lr_no: string | null;
  pieces: number; total_qty: number; taxable_value: number; amount_in_words: string;
  lines: { hsn_code: string; quality: string; construction: string; pieces: number;
           qty: number; uom: string; taxable_value: number; gst_rate: number }[];
}

const money = (n: number | null) =>
  n == null ? '' : `₹${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

const ChallanPrint: React.FC<{ issueId: string; onClose: () => void }> = ({ issueId, onClose }) => {
  const { data, error } = useApi<PrintDoc>(`/delivery-challans/${issueId}/print`);
  if (error) return <div className="p-4 text-red-700">{error}</div>;
  if (!data) return <div className="p-4 text-slate-500">Loading…</div>;

  return (
    <div className="absolute inset-0 bg-black/40 flex items-start justify-center p-4 z-50 overflow-auto print:static print:bg-white print:p-0">
      <div className="bg-white w-full max-w-3xl border border-slate-400 print-area">
        <div className="flex items-center gap-2 px-3 py-2 bg-blue-800 text-white print:hidden">
          <span className="font-bold">Delivery Challan — Rule 55</span>
          <button onClick={() => window.print()} className="ml-auto erp-btn" title="Print">
            <Printer className="w-3.5 h-3.5" />
          </button>
          <button onClick={onClose} title="Close"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-5 text-xs">
          <h2 className="text-center font-bold text-sm">DELIVERY CHALLAN</h2>
          <p className="text-center text-[10px] text-slate-500 mb-1">
            (Goods sent for job work — not a supply. Rule 55 of the CGST Rules, 2017)
          </p>
          <p className="text-center text-[10px] text-slate-600 mb-4">Triplicate — for the consigner</p>

          <div className="grid grid-cols-2 gap-4 mb-4">
            <div className="border border-slate-300 p-2">
              <div className="font-bold text-[10px] uppercase text-slate-500">Consigner</div>
              <div className="font-bold">{data.consignor_name}</div>
              <div>{data.consignor_addr}</div>
              <div>{data.consignor_city} — {data.consignor_pincode}</div>
              <div>GSTIN: <span className="font-mono">{data.consignor_gstin}</span></div>
              <div>State code: {data.consignor_state}</div>
            </div>
            <div className="border border-slate-300 p-2">
              <div className="font-bold text-[10px] uppercase text-slate-500">Consignee (job worker)</div>
              <div className="font-bold">{data.consignee_name}</div>
              <div>{data.consignee_addr ?? '—'}</div>
              <div>{data.consignee_city} — {data.consignee_pincode}</div>
              <div>GSTIN: <span className="font-mono">{data.consignee_gstin ?? 'URP'}</span></div>
              <div>State code: {data.consignee_state}</div>
            </div>
          </div>

          <div className="grid grid-cols-4 gap-2 mb-3 text-[11px]">
            <div><span className="text-slate-500">Challan no</span><div className="font-mono font-bold">{data.challan_no}</div></div>
            <div><span className="text-slate-500">Date</span><div className="font-bold">{data.challan_date}</div></div>
            <div><span className="text-slate-500">Lot</span><div>{data.lot_no || '—'}</div></div>
            <div><span className="text-slate-500">Bales / vehicle</span><div>{data.no_of_bales} / {data.vehicle_no ?? '—'}</div></div>
          </div>

          <table className="w-full border border-slate-400 mb-3">
            <thead className="bg-slate-100">
              <tr className="text-left">
                <th className="border border-slate-300 px-1.5 py-1">Description of goods</th>
                <th className="border border-slate-300 px-1.5 py-1">HSN</th>
                <th className="border border-slate-300 px-1.5 py-1 text-right">Pcs</th>
                <th className="border border-slate-300 px-1.5 py-1 text-right">Qty</th>
                <th className="border border-slate-300 px-1.5 py-1">UQC</th>
                <th className="border border-slate-300 px-1.5 py-1 text-right">Rate %</th>
                <th className="border border-slate-300 px-1.5 py-1 text-right">Taxable value</th>
              </tr>
            </thead>
            <tbody>
              {data.lines.map(l => (
                <tr key={l.hsn_code + l.quality}>
                  <td className="border border-slate-300 px-1.5 py-1">
                    {l.quality}
                    {l.construction && <div className="text-[10px] text-slate-500">{l.construction}</div>}
                  </td>
                  <td className="border border-slate-300 px-1.5 py-1 font-mono">{l.hsn_code}</td>
                  <td className="border border-slate-300 px-1.5 py-1 text-right font-mono">{l.pieces}</td>
                  <td className="border border-slate-300 px-1.5 py-1 text-right font-mono">{Number(l.qty).toFixed(2)}</td>
                  <td className="border border-slate-300 px-1.5 py-1">{l.uom}</td>
                  <td className="border border-slate-300 px-1.5 py-1 text-right">{l.gst_rate}</td>
                  <td className="border border-slate-300 px-1.5 py-1 text-right font-mono">{money(l.taxable_value)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="font-bold bg-slate-50">
                <td className="border border-slate-300 px-1.5 py-1" colSpan={2}>Total</td>
                <td className="border border-slate-300 px-1.5 py-1 text-right font-mono">{data.pieces}</td>
                <td className="border border-slate-300 px-1.5 py-1 text-right font-mono">{Number(data.total_qty).toFixed(2)}</td>
                <td className="border border-slate-300 px-1.5 py-1" colSpan={2}></td>
                <td className="border border-slate-300 px-1.5 py-1 text-right font-mono">{money(data.taxable_value)}</td>
              </tr>
            </tfoot>
          </table>

          <p className="mb-4"><span className="text-slate-500">Amount in words:</span>{' '}
            <span className="font-semibold">{data.amount_in_words}</span></p>

          <p className="text-[10px] text-slate-600 mb-6">
            Goods described above are sent for job work and are to be returned within the period
            prescribed by section 143(1). Tax is not charged on this movement.
          </p>

          <div className="flex justify-between mt-8">
            <div className="text-[10px]">Receiver's signature</div>
            <div className="text-right text-[10px]">
              For {data.consignor_name}
              <div className="mt-8">Authorised signatory</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export const DeliveryChallanView: React.FC = () => {
  const list = usePagedList<ChallanRow>('/delivery-challans');
  const [printing, setPrinting] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const raiseEway = async (row: ChallanRow) => {
    const km = Number(prompt(`Distance to ${row.consignee_name} in km?`, '40'));
    if (!km || km < 1) return;
    setBusy(row.issue_id);
    try {
      const out = await api.post<any>(`/eway-bills/challan/${row.issue_id}`, {
        distanceKm: Math.round(km),
        vehicleNo: prompt('Vehicle number') || null
      });
      setNotice(out.ok
        ? `E-way bill ${out.ewayBill.ourRef} prepared for ${row.challan_no} — valid to ${out.ewayBill.validUntil}`
        : `Blocked: ${out.issues.map((i: any) => `${i.field}: ${i.problem}`).join('; ')}`);
      list.reload();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col h-full bg-[#ecf1f7] text-slate-800 text-xs">
      <ToolbarRibbon
        title="Delivery Challans (job work)"
        actions={[
          { key: 'export', onRun: () => void list.exportCsv() },
          { key: 'print', onRun: () => window.print() }
        ]}
      />

      {notice && (
        <div className={`px-4 py-1.5 flex items-center gap-2 font-semibold ${
          notice.startsWith('Blocked') ? 'bg-red-600 text-white' : 'bg-emerald-600 text-white'
        }`}>
          {notice.startsWith('Blocked') ? <AlertTriangle className="w-4 h-4" /> : <CheckCircle2 className="w-4 h-4" />}
          <span>{notice}</span>
          <button onClick={() => setNotice(null)} className="ml-auto"><X className="w-4 h-4" /></button>
        </div>
      )}

      <ListControls list={list} placeholder="Challan no, process house or lot…" />

      <div className="flex-1 overflow-auto">
        <table className="w-full bg-white">
          <thead className="bg-slate-100 border-b border-slate-300 text-left sticky top-0">
            <tr>
              <th className="px-2 py-1.5 font-bold">Challan</th>
              <th className="px-2 py-1.5 font-bold">Date</th>
              <th className="px-2 py-1.5 font-bold">Process house</th>
              <th className="px-2 py-1.5 font-bold">GSTIN</th>
              <th className="px-2 py-1.5 font-bold">Lot</th>
              <th className="px-2 py-1.5 font-bold text-right">Pcs</th>
              <th className="px-2 py-1.5 font-bold text-right">Qty</th>
              <th className="px-2 py-1.5 font-bold text-right">Value</th>
              <th className="px-2 py-1.5 font-bold">E-way bill</th>
              <th className="px-2 py-1.5"></th>
            </tr>
          </thead>
          <tbody>
            {list.rows.map(r => (
              <tr key={r.issue_id} className="border-b border-slate-100 hover:bg-blue-50/40">
                <td className="px-2 py-1 font-mono text-blue-800">{r.challan_no}</td>
                <td className="px-2 py-1">{r.challan_date}</td>
                <td className="px-2 py-1">{r.consignee_name}</td>
                <td className="px-2 py-1 font-mono text-[10px]">{r.consignee_gstin ?? 'URP'}</td>
                <td className="px-2 py-1">{r.lot_no || '—'}</td>
                <td className="px-2 py-1 text-right font-mono">{r.pieces}</td>
                <td className="px-2 py-1 text-right font-mono">{Number(r.total_qty).toFixed(2)}</td>
                <td className="px-2 py-1 text-right font-mono">{money(r.taxable_value)}</td>
                <td className="px-2 py-1">
                  {r.ewb_ref
                    ? <span className="px-1.5 py-0.5 rounded border bg-emerald-50 border-emerald-300 text-emerald-800 font-semibold">
                        {r.ewb_no ?? r.ewb_ref} · to {r.ewb_valid_until}
                      </span>
                    : <span className="text-slate-400">none</span>}
                </td>
                <td className="px-2 py-1 text-right whitespace-nowrap">
                  <button onClick={() => setPrinting(r.issue_id)} className="erp-btn" title="Print Rule 55 challan">
                    <Printer className="w-3.5 h-3.5 text-blue-700" />
                  </button>
                  <button onClick={() => raiseEway(r)} disabled={busy === r.issue_id}
                    className="erp-btn disabled:opacity-40" title="Prepare e-way bill">
                    <Truck className="w-3.5 h-3.5 text-slate-600" />
                  </button>
                </td>
              </tr>
            ))}
            {!list.loading && list.rows.length === 0 && (
              <tr><td colSpan={10} className="px-2 py-6 text-center text-slate-400">
                No delivery challans yet — issue grey to a dyeing house first
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {printing && <ChallanPrint issueId={printing} onClose={() => setPrinting(null)} />}
    </div>
  );
};
