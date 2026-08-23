import { useState } from 'react';
import { Printer, X } from 'lucide-react';
import { ToolbarRibbon } from '../components/ToolbarRibbon';
import { ListControls } from '../components/ListControls';
import { usePagedList } from '../lib/usePagedList';
import { useApi } from '../lib/useApi';

interface DispatchRow {
  id: string;
  challan_no: string;
  challan_date: string;
  party_name: string;
  pieces: number;
  value: number;
  invoiced: boolean;
}

interface PackingList {
  challan_no: string;
  challan_date: string;
  lr_no: string | null;
  lr_date: string | null;
  vehicle_no: string | null;
  status: string;
  consignor_name: string;
  consignor_gstin: string;
  consignor_address: string | null;
  consignor_address2: string | null;
  consignor_city: string | null;
  consignor_pincode: string | null;
  customer_name: string;
  customer_gstin: string | null;
  delivery_name: string;
  delivery_gstin: string | null;
  delivery_address: string | null;
  delivery_city: string | null;
  delivery_pincode: string | null;
  delivery_state: string | null;
  transport_name: string | null;
  transporter_gstin: string | null;
  pieces: number;
  total_qty: number;
  total_value: number;
  lines: {
    sno: number;
    barcode: string;
    lot_no: string;
    grade_code: string;
    uom: string;
    quality: string;
    construction: string;
    hsn_code: string;
    design: string | null;
    qty: number;
  }[];
}

const PackingPrint: React.FC<{ dispatchId: string; onClose: () => void }> = ({ dispatchId, onClose }) => {
  const { data, error } = useApi<PackingList>(`/dispatches/${dispatchId}/packing-list`);
  if (error) return <div role="alert" className="p-4 text-red-700">{error}</div>;
  if (!data) return <div className="p-4 text-slate-500">Loading packing list…</div>;

  return (
    <div className="absolute inset-0 z-50 overflow-auto bg-black/40 p-4 print:static print:bg-white print:p-0">
      <div className="print-area mx-auto w-full max-w-4xl border border-slate-400 bg-white">
        <div className="flex items-center gap-2 bg-blue-800 px-3 py-2 text-white print:hidden">
          <strong>Packing List — {data.challan_no}</strong>
          <button type="button" onClick={() => window.print()} className="erp-btn ml-auto" title="Print packing list">
            <Printer className="h-4 w-4" /> Print
          </button>
          <button type="button" onClick={onClose} className="min-h-11 min-w-11" aria-label="Close packing list">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-5 text-xs">
          {data.status === 'cancelled' && (
            <div className="mb-3 border-2 border-red-600 py-2 text-center text-lg font-black text-red-700">CANCELLED</div>
          )}
          <h1 className="text-center text-base font-bold">PACKING LIST</h1>
          <p className="mb-4 text-center text-[10px] text-slate-500">Piece-wise list accompanying delivery challan</p>

          <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <section className="border border-slate-300 p-2" aria-label="From">
              <div className="text-[10px] font-bold uppercase text-slate-500">From</div>
              <div className="font-bold">{data.consignor_name}</div>
              <div>{[data.consignor_address, data.consignor_address2].filter(Boolean).join(', ') || '—'}</div>
              <div>{data.consignor_city ?? '—'} {data.consignor_pincode ? `— ${data.consignor_pincode}` : ''}</div>
              <div>GSTIN: <span className="font-mono">{data.consignor_gstin}</span></div>
            </section>
            <section className="border border-slate-300 p-2" aria-label="Deliver to">
              <div className="text-[10px] font-bold uppercase text-slate-500">Deliver to</div>
              <div className="font-bold">{data.delivery_name}</div>
              <div>{data.delivery_address ?? '—'}</div>
              <div>{data.delivery_city ?? '—'} {data.delivery_pincode ? `— ${data.delivery_pincode}` : ''}</div>
              <div>GSTIN: <span className="font-mono">{data.delivery_gstin ?? 'URP'}</span></div>
            </section>
          </div>

          <div className="mb-3 grid grid-cols-2 gap-2 text-[11px] sm:grid-cols-5">
            <div><span className="text-slate-500">Challan</span><div className="font-mono font-bold">{data.challan_no}</div></div>
            <div><span className="text-slate-500">Date</span><div>{data.challan_date}</div></div>
            <div><span className="text-slate-500">Transport</span><div>{data.transport_name ?? '—'}</div></div>
            <div><span className="text-slate-500">LR no / date</span><div>{data.lr_no ?? '—'}{data.lr_date ? ` / ${data.lr_date}` : ''}</div></div>
            <div><span className="text-slate-500">Vehicle</span><div>{data.vehicle_no ?? '—'}</div></div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full border border-slate-400">
              <thead className="bg-slate-100 text-left">
                <tr>
                  <th className="border border-slate-300 px-1.5 py-1">#</th>
                  <th className="border border-slate-300 px-1.5 py-1">Barcode</th>
                  <th className="border border-slate-300 px-1.5 py-1">Lot</th>
                  <th className="border border-slate-300 px-1.5 py-1">Quality / design</th>
                  <th className="border border-slate-300 px-1.5 py-1">HSN</th>
                  <th className="border border-slate-300 px-1.5 py-1">Grade</th>
                  <th className="border border-slate-300 px-1.5 py-1 text-right">Qty</th>
                  <th className="border border-slate-300 px-1.5 py-1">UQC</th>
                </tr>
              </thead>
              <tbody>
                {data.lines.map(line => (
                  <tr key={line.barcode}>
                    <td className="border border-slate-300 px-1.5 py-1">{line.sno}</td>
                    <td className="border border-slate-300 px-1.5 py-1 font-mono font-bold">{line.barcode}</td>
                    <td className="border border-slate-300 px-1.5 py-1">{line.lot_no || '—'}</td>
                    <td className="border border-slate-300 px-1.5 py-1">{line.quality}{line.design ? ` / ${line.design}` : ''}</td>
                    <td className="border border-slate-300 px-1.5 py-1 font-mono">{line.hsn_code}</td>
                    <td className="border border-slate-300 px-1.5 py-1">{line.grade_code}</td>
                    <td className="border border-slate-300 px-1.5 py-1 text-right font-mono">{Number(line.qty).toFixed(2)}</td>
                    <td className="border border-slate-300 px-1.5 py-1">{line.uom}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-slate-50 font-bold">
                  <td className="border border-slate-300 px-1.5 py-1" colSpan={6}>Total — {data.pieces} piece(s)</td>
                  <td className="border border-slate-300 px-1.5 py-1 text-right font-mono">{Number(data.total_qty).toFixed(2)}</td>
                  <td className="border border-slate-300 px-1.5 py-1"></td>
                </tr>
              </tfoot>
            </table>
          </div>

          <div className="mt-12 flex justify-between text-[10px]">
            <span>Receiver’s signature</span>
            <span>For {data.consignor_name}<br /><br />Authorised signatory</span>
          </div>
        </div>
      </div>
    </div>
  );
};

export const PackingListView: React.FC = () => {
  const list = usePagedList<DispatchRow>('/dispatches');
  const [printing, setPrinting] = useState<string | null>(null);

  return (
    <div className="flex h-full flex-col bg-[#ecf1f7] text-xs text-slate-800">
      <ToolbarRibbon title="Customer Packing Lists" actions={[
        { key: 'export', onRun: () => void list.exportCsv() },
        { key: 'print', onRun: () => window.print() }
      ]} />
      <ListControls list={list} placeholder="Challan or customer…" />
      <div className="flex-1 overflow-auto">
        <table className="w-full bg-white">
          <thead className="sticky top-0 border-b border-slate-300 bg-slate-100 text-left">
            <tr>
              <th className="px-2 py-1.5">Challan</th>
              <th className="px-2 py-1.5">Date</th>
              <th className="px-2 py-1.5">Customer</th>
              <th className="px-2 py-1.5 text-right">Pieces</th>
              <th className="px-2 py-1.5">Invoice</th>
              <th className="px-2 py-1.5"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {list.rows.map(row => (
              <tr key={row.id} className="border-b border-slate-100 hover:bg-blue-50/40">
                <td className="px-2 py-1 font-mono font-bold text-blue-800">{row.challan_no}</td>
                <td className="px-2 py-1">{row.challan_date}</td>
                <td className="px-2 py-1">{row.party_name}</td>
                <td className="px-2 py-1 text-right font-mono">{row.pieces}</td>
                <td className="px-2 py-1">{row.invoiced ? 'Raised' : 'Pending'}</td>
                <td className="px-2 py-1 text-right">
                  <button type="button" className="erp-btn" onClick={() => setPrinting(row.id)}
                    title={`Print packing list ${row.challan_no}`}>
                    <Printer className="h-3.5 w-3.5" /> Packing list
                  </button>
                </td>
              </tr>
            ))}
            {list.rows.length === 0 && !list.loading && (
              <tr><td colSpan={6} className="p-8 text-center text-slate-500">No dispatches to pack yet</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {printing && <PackingPrint dispatchId={printing} onClose={() => setPrinting(null)} />}
    </div>
  );
};
