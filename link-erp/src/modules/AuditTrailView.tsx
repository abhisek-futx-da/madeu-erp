import React, { useState } from 'react';
import { ToolbarRibbon } from '../components/ToolbarRibbon';
import { useApi } from '../lib/useApi';
import { STATUS_LABEL, type MovementRow, type PieceRow } from '../lib/api';
import { code128DataUri } from '../lib/barcode';
import { Search, AlertTriangle, ShieldCheck } from 'lucide-react';

interface DriftRow {
  barcode: string; cached_status: string; log_status: string;
  cached_qty: number; log_qty: number;
}

const when = (v: string) => new Date(v).toLocaleString('en-GB');
const stage = (v: string | null) => (v ? STATUS_LABEL[v] ?? v : '—');

/**
 * The audit trail over `piece_movement`. The best data in the system had no
 * screen: you could prove a piece's history in SQL and nowhere else.
 */
export const AuditTrailView: React.FC = () => {
  const [barcode, setBarcode] = useState('');
  const [query, setQuery] = useState('');

  const history = useApi<MovementRow[]>(
    query ? `/pieces/${encodeURIComponent(query)}/history` : null, [query]
  );
  const piece = useApi<PieceRow[]>(
    query ? `/pieces?barcode=${encodeURIComponent(query)}` : null, [query]
  );
  const drift = useApi<DriftRow[]>('/reports/piece-drift');

  const p = piece.data?.[0];
  const rows = history.data ?? [];

  return (
    <div className="flex flex-col h-full bg-[#ecf1f7] text-slate-800 text-xs">
      <ToolbarRibbon title="Audit Trail — piece history" onPrint={() => window.print()} />

      <form
        onSubmit={e => { e.preventDefault(); setQuery(barcode.trim()); }}
        className="no-print px-3 py-2 bg-white border-b border-slate-200 flex items-center gap-2"
      >
        <Search className="w-4 h-4 text-blue-700" />
        <label className="font-bold text-blue-900" htmlFor="bc">Barcode</label>
        <input id="bc" autoFocus value={barcode} onChange={e => setBarcode(e.target.value)}
               placeholder="scan or type, then Enter" className="erp-input font-mono w-64" />
        <button type="submit" className="erp-btn erp-btn-primary font-bold">Trace</button>

        <span className="ml-auto flex items-center gap-1.5 font-semibold">
          {(drift.data ?? []).length === 0 ? (
            <><ShieldCheck className="w-4 h-4 text-emerald-600" />
              <span className="text-emerald-800">Spine consistent</span></>
          ) : (
            <><AlertTriangle className="w-4 h-4 text-red-600" />
              <span className="text-red-800">{drift.data!.length} piece(s) drifted from the log</span></>
          )}
        </span>
      </form>

      <div className="flex-1 overflow-auto p-3 space-y-3 print-area">
        {(drift.data ?? []).length > 0 && (
          <div className="bg-red-50 border border-red-300 rounded p-3">
            <p className="font-bold text-red-900 mb-1">
              These pieces disagree with their own movement log
            </p>
            <p className="text-red-800 mb-2">
              The cached status and quantity on the piece are a fold of the log. A mismatch
              means something wrote to the piece directly. The log is the truth.
            </p>
            <table className="w-full bg-white">
              <thead className="bg-red-100 text-left">
                <tr>
                  <th className="px-2 py-1">Barcode</th>
                  <th className="px-2 py-1">Cached</th>
                  <th className="px-2 py-1">Log says</th>
                  <th className="px-2 py-1 text-right">Cached qty</th>
                  <th className="px-2 py-1 text-right">Log qty</th>
                </tr>
              </thead>
              <tbody>
                {drift.data!.map(d => (
                  <tr key={d.barcode} className="border-b border-red-100">
                    <td className="px-2 py-1 font-mono">{d.barcode}</td>
                    <td className="px-2 py-1">{stage(d.cached_status)}</td>
                    <td className="px-2 py-1 font-bold">{stage(d.log_status)}</td>
                    <td className="px-2 py-1 text-right font-mono">{d.cached_qty}</td>
                    <td className="px-2 py-1 text-right font-mono font-bold">{d.log_qty}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {!query && (
          <p className="p-8 text-center text-slate-400">
            Scan a barcode to see everywhere that piece has been.
          </p>
        )}

        {query && p && (
          <div className="bg-white rounded border border-[#b8c9dd] p-3 flex items-start gap-4">
            <img src={code128DataUri(p.barcode, { height: 44, module: 1.6 })}
                 alt={p.barcode} style={{ height: '14mm' }} />
            <div className="grid grid-cols-4 gap-x-6 gap-y-1 flex-1">
              <Field label="Barcode" value={p.barcode} mono />
              <Field label="Quality" value={p.quality} />
              <Field label="Design" value={p.design ?? '—'} />
              <Field label="Grade" value={p.grade_code} />
              <Field label="Lot" value={p.lot_no || '—'} />
              <Field label="Stage" value={stage(p.status)} />
              <Field label="Grey qty" value={`${Number(p.grey_qty).toFixed(2)} MTR`} mono />
              <Field label="Now" value={`${Number(p.current_qty).toFixed(2)} MTR`} mono />
              <Field label="Weight" value={p.current_weight_kg == null ? 'Not captured' : `${Number(p.current_weight_kg).toFixed(3)} KG`} mono />
              <Field label="GLM" value={p.glm == null ? '—' : `${Number(p.glm).toFixed(3)} g/m`} mono />
              <Field label="GSM" value={p.gsm == null ? '—' : Number(p.gsm).toFixed(2)} mono />
              {p.held_by && <Field label="Lying with" value={p.held_by} />}
            </div>
          </div>
        )}

        {query && rows.length > 0 && (
          <div className="bg-white rounded border border-[#b8c9dd] overflow-hidden">
            <table className="w-full">
              <thead className="bg-slate-100 border-b border-slate-300 text-left">
                <tr>
                  <th className="px-2 py-1.5 font-bold">#</th>
                  <th className="px-2 py-1.5 font-bold">When</th>
                  <th className="px-2 py-1.5 font-bold">Event</th>
                  <th className="px-2 py-1.5 font-bold">From</th>
                  <th className="px-2 py-1.5 font-bold">To</th>
                  <th className="px-2 py-1.5 font-bold text-right">Qty before</th>
                  <th className="px-2 py-1.5 font-bold text-right">Qty after</th>
                  <th className="px-2 py-1.5 font-bold text-right">Kg before</th>
                  <th className="px-2 py-1.5 font-bold text-right">Kg after</th>
                  <th className="px-2 py-1.5 font-bold">Counterparty</th>
                  <th className="px-2 py-1.5 font-bold">Document</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((m, i) => {
                  const lost = Number(m.qty_before) - Number(m.qty_after);
                  return (
                    <tr key={i} className="border-b border-slate-100">
                      <td className="px-2 py-1 text-slate-400">{i + 1}</td>
                      <td className="px-2 py-1 font-mono">{when(m.occurred_at)}</td>
                      <td className="px-2 py-1 font-bold uppercase">{m.event}</td>
                      <td className="px-2 py-1">{stage(m.from_status)}</td>
                      <td className="px-2 py-1 font-semibold">{stage(m.to_status)}</td>
                      <td className="px-2 py-1 text-right font-mono">{Number(m.qty_before).toFixed(2)}</td>
                      <td className={`px-2 py-1 text-right font-mono ${
                        lost > 0.005 ? 'text-amber-800 font-bold' : ''
                      }`}>
                        {Number(m.qty_after).toFixed(2)}
                        {lost > 0.005 && <span className="ml-1 text-[10px]">(−{lost.toFixed(2)})</span>}
                      </td>
                      <td className="px-2 py-1 text-right font-mono">{m.weight_before_kg == null ? '—' : Number(m.weight_before_kg).toFixed(3)}</td>
                      <td className="px-2 py-1 text-right font-mono">{m.weight_after_kg == null ? '—' : Number(m.weight_after_kg).toFixed(3)}</td>
                      <td className="px-2 py-1">{m.counterparty ?? ''}</td>
                      <td className="px-2 py-1 text-slate-500">{m.doc_type}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="px-3 py-2 bg-slate-50 border-t border-slate-300 text-slate-600">
              This log is append-only. Updates and deletes against it do nothing —
              the database refuses them.
            </p>
          </div>
        )}

        {query && !history.loading && rows.length === 0 && (
          <p className="p-8 text-center text-slate-400">No piece with that barcode.</p>
        )}
      </div>
    </div>
  );
};

const Field: React.FC<{ label: string; value: string; mono?: boolean }> = ({ label, value, mono }) => (
  <div>
    <div className="erp-label">{label}</div>
    <div className={`font-semibold ${mono ? 'font-mono text-blue-800' : ''}`}>{value}</div>
  </div>
);
