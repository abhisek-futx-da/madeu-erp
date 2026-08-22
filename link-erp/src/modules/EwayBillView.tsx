import { useState } from 'react';
import { FileJson, X, Ban } from 'lucide-react';
import { ToolbarRibbon } from '../components/ToolbarRibbon';
import { ListControls } from '../components/ListControls';
import { usePagedList } from '../lib/usePagedList';
import { api } from '../lib/api';

/**
 * Every e-way bill the mill has prepared, on invoices and on job-work
 * challans alike, with the payload that would be posted to the NIC gateway.
 */

interface EwbRow {
  id: string; our_ref: string; ewb_no: string | null; status: string;
  source_doc: string; doc_type: string; doc_no: string; doc_date: string;
  sub_supply_type: string; to_gstin: string; to_state_code: string;
  distance_km: number; vehicle_no: string | null;
  total_value: number; valid_until: string; last_error: string | null;
}

const SUB_SUPPLY: Record<string, string> = {
  '1': 'Supply', '3': 'Export', '4': 'Job Work', '5': 'Sale on approval', '8': 'Others'
};

const money = (n: number) => `₹${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

const STATUS_STYLE: Record<string, string> = {
  draft: 'bg-amber-50 border-amber-300 text-amber-900',
  generated: 'bg-emerald-50 border-emerald-300 text-emerald-800',
  cancelled: 'bg-slate-100 border-slate-300 text-slate-500 line-through',
  failed: 'bg-red-50 border-red-300 text-red-800'
};

export const EwayBillView: React.FC = () => {
  const list = usePagedList<EwbRow>('/eway-bills');
  const [payload, setPayload] = useState<{ ref: string; json: unknown } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const show = async (row: EwbRow) => {
    const doc = await api.get<{ payload: unknown }>(`/eway-bills/${row.id}/payload`);
    setPayload({ ref: row.our_ref, json: doc.payload });
  };

  const cancel = async (row: EwbRow) => {
    const reason = prompt(`Why is ${row.our_ref} being cancelled?`);
    if (!reason) return;
    try {
      await api.post(`/eway-bills/${row.id}/cancel`, { reason });
      setNotice(`${row.our_ref} cancelled`);
      list.reload();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="flex flex-col h-full bg-[#ecf1f7] text-slate-800 text-xs">
      <ToolbarRibbon
        title="E-Way Bills (Rule 138)"
        actions={[
          { key: 'export', onRun: () => void list.exportCsv() },
          { key: 'print', onRun: () => window.print() }
        ]}
      />

      {notice && (
        <div className="px-4 py-1.5 bg-blue-700 text-white font-semibold flex items-center gap-2">
          <span>{notice}</span>
          <button onClick={() => setNotice(null)} className="ml-auto"><X className="w-4 h-4" /></button>
        </div>
      )}

      <div className="px-3 py-1.5 bg-amber-50 border-b border-amber-200 text-amber-900 print:hidden">
        Payloads are built and validated against the NIC EWB v1.03 schema. Sending them to the
        portal needs a GSP subscription, which is not wired up.
      </div>

      <ListControls list={list} placeholder="Our ref, document no, EWB no or vehicle…" />

      <div className="flex-1 overflow-auto">
        <table className="w-full bg-white">
          <thead className="bg-slate-100 border-b border-slate-300 text-left sticky top-0">
            <tr>
              <th className="px-2 py-1.5 font-bold">Ref</th>
              <th className="px-2 py-1.5 font-bold">EWB no</th>
              <th className="px-2 py-1.5 font-bold">Type</th>
              <th className="px-2 py-1.5 font-bold">Document</th>
              <th className="px-2 py-1.5 font-bold">Date</th>
              <th className="px-2 py-1.5 font-bold">To GSTIN</th>
              <th className="px-2 py-1.5 font-bold text-right">Km</th>
              <th className="px-2 py-1.5 font-bold">Vehicle</th>
              <th className="px-2 py-1.5 font-bold text-right">Value</th>
              <th className="px-2 py-1.5 font-bold">Valid to</th>
              <th className="px-2 py-1.5 font-bold">Status</th>
              <th className="px-2 py-1.5"></th>
            </tr>
          </thead>
          <tbody>
            {list.rows.map(r => (
              <tr key={r.id} className="border-b border-slate-100 hover:bg-blue-50/40">
                <td className="px-2 py-1 font-mono text-blue-800">{r.our_ref}</td>
                <td className="px-2 py-1 font-mono">{r.ewb_no ?? '—'}</td>
                <td className="px-2 py-1">
                  {SUB_SUPPLY[r.sub_supply_type] ?? r.sub_supply_type}
                  <span className="text-slate-400 ml-1">{r.doc_type}</span>
                </td>
                <td className="px-2 py-1 font-mono">{r.doc_no}</td>
                <td className="px-2 py-1">{r.doc_date}</td>
                <td className="px-2 py-1 font-mono text-[10px]">{r.to_gstin} · {r.to_state_code}</td>
                <td className="px-2 py-1 text-right font-mono">{r.distance_km}</td>
                <td className="px-2 py-1 font-mono">{r.vehicle_no ?? '—'}</td>
                <td className="px-2 py-1 text-right font-mono">{money(r.total_value)}</td>
                <td className="px-2 py-1">{r.valid_until}</td>
                <td className="px-2 py-1">
                  <span className={`px-1.5 py-0.5 rounded border font-semibold ${STATUS_STYLE[r.status]}`}
                    title={r.last_error ?? undefined}>
                    {r.status}
                  </span>
                </td>
                <td className="px-2 py-1 text-right whitespace-nowrap">
                  <button onClick={() => show(r)} className="erp-btn" title="View NIC payload">
                    <FileJson className="w-3.5 h-3.5 text-blue-600" />
                  </button>
                  {r.status !== 'cancelled' && (
                    <button onClick={() => cancel(r)} className="erp-btn" title="Cancel this bill">
                      <Ban className="w-3.5 h-3.5 text-red-600" />
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {!list.loading && list.rows.length === 0 && (
              <tr><td colSpan={12} className="px-2 py-6 text-center text-slate-400">
                No e-way bills yet — prepare one from an invoice or a delivery challan
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {payload && (
        <div className="absolute inset-0 bg-black/40 flex items-center justify-center p-8 z-50">
          <div className="bg-white rounded border border-slate-400 shadow-xl w-full max-w-3xl max-h-full flex flex-col">
            <header className="px-3 py-2 bg-blue-800 text-white flex items-center gap-2">
              <FileJson className="w-4 h-4" />
              <span className="font-bold">NIC EWB payload — {payload.ref}</span>
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
