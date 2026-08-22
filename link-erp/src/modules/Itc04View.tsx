import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { ToolbarRibbon } from '../components/ToolbarRibbon';
import { useApi } from '../lib/useApi';
import { api } from '../lib/api';

/**
 * ITC-04 — the return that reports goods sent to and received back from a job
 * worker. Mandatory for a processing mill and previously absent entirely.
 * Table 4 is what went out; Table 5A is what came back.
 */

interface SentRow {
  job_worker: string; job_worker_gstin: string; challan_no: string; challan_date: string;
  hsn_code: string; uom: string; qty: number; taxable_value: number; goods_type: string;
}
interface ReceivedRow {
  job_worker: string; original_challan_no: string; original_challan_date: string;
  jobworker_challan_no: string; jobworker_challan_date: string;
  hsn_code: string; uom: string; sent_qty: number; qty: number; loss_qty: number;
}
interface PendingRow {
  job_worker: string; challan_no: string; challan_date: string;
  pieces: number; qty: number; days_out: number; beyond_one_year: boolean;
}

const num = (n: number) => Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2 });

/** Quarters of the Indian financial year, newest first. */
function quarters(count = 8): string[] {
  const now = new Date();
  const out: string[] = [];
  let y = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  let q = Math.floor(((now.getMonth() + 9) % 12) / 3) + 1;
  for (let i = 0; i < count; i++) {
    out.push(`Q${q}-${y}`);
    if (--q === 0) { q = 4; y -= 1; }
  }
  return out;
}

export const Itc04View: React.FC = () => {
  const options = quarters();
  const [period, setPeriod] = useState(options[0]!);
  const { data, error, loading } = useApi<{
    returnPeriod: string; sent: SentRow[]; received: ReceivedRow[]; pending: PendingRow[];
  }>(`/itc04/${period}`);

  const overdue = (data?.pending ?? []).filter(p => p.beyond_one_year);

  return (
    <div className="flex flex-col h-full bg-[#ecf1f7] text-slate-800 text-xs">
      <ToolbarRibbon
        title="ITC-04 — job work return"
        actions={[
          { key: 'export', onRun: () => void api.download(`/itc04/${period}?format=csv`, `itc04-${period}`) },
          { key: 'print', onRun: () => window.print() }
        ]}
      />

      <div className="flex items-center gap-3 px-3 py-2 bg-slate-50 border-b border-slate-200 print:hidden">
        <label className="flex items-center gap-1">
          Return period
          <select value={period} onChange={e => setPeriod(e.target.value)}
            className="border border-slate-300 rounded px-2 py-1">
            {options.map(q => <option key={q} value={q}>{q}</option>)}
          </select>
        </label>
        {loading && <span className="text-slate-500">Loading…</span>}
        <span className="ml-auto text-slate-500">
          Half-yearly if turnover is ₹5 crore or less, quarterly above it.
        </span>
      </div>

      {error && <div className="px-4 py-2 bg-red-600 text-white font-semibold">{error}</div>}

      {overdue.length > 0 && (
        <div className="px-4 py-2 bg-red-600 text-white font-semibold flex items-center gap-2">
          <AlertTriangle className="w-4 h-4" />
          {overdue.length} challan(s) have been out beyond one year — section 143(1) treats those
          goods as supplied on the day they were sent.
        </div>
      )}

      <div className="flex-1 overflow-auto p-3 space-y-3 print-area">
        <section className="bg-white rounded border border-[#b8c9dd]">
          <header className="px-3 py-2 border-b border-slate-200 font-bold text-blue-900">
            Table 4 — goods sent to the job worker ({data?.sent.length ?? 0} rows)
          </header>
          <table className="w-full">
            <thead className="bg-slate-100 border-b border-slate-300 text-left">
              <tr>
                <th className="px-2 py-1.5 font-bold">Job worker</th>
                <th className="px-2 py-1.5 font-bold">GSTIN</th>
                <th className="px-2 py-1.5 font-bold">Challan</th>
                <th className="px-2 py-1.5 font-bold">Date</th>
                <th className="px-2 py-1.5 font-bold">HSN</th>
                <th className="px-2 py-1.5 font-bold">UQC</th>
                <th className="px-2 py-1.5 font-bold text-right">Qty</th>
                <th className="px-2 py-1.5 font-bold text-right">Taxable value</th>
              </tr>
            </thead>
            <tbody>
              {(data?.sent ?? []).slice(0, 200).map((r, i) => (
                <tr key={`${r.challan_no}-${r.hsn_code}-${i}`} className="border-b border-slate-100">
                  <td className="px-2 py-1">{r.job_worker}</td>
                  <td className="px-2 py-1 font-mono text-[10px]">{r.job_worker_gstin}</td>
                  <td className="px-2 py-1 font-mono">{r.challan_no}</td>
                  <td className="px-2 py-1">{r.challan_date}</td>
                  <td className="px-2 py-1 font-mono">{r.hsn_code}</td>
                  <td className="px-2 py-1">{r.uom}</td>
                  <td className="px-2 py-1 text-right font-mono">{num(r.qty)}</td>
                  <td className="px-2 py-1 text-right font-mono">{num(r.taxable_value)}</td>
                </tr>
              ))}
              {(data?.sent ?? []).length === 0 && !loading && (
                <tr><td colSpan={8} className="px-2 py-5 text-center text-slate-400">
                  Nothing sent out in {period}
                </td></tr>
              )}
            </tbody>
          </table>
        </section>

        <section className="bg-white rounded border border-[#b8c9dd]">
          <header className="px-3 py-2 border-b border-slate-200 font-bold text-blue-900">
            Table 5A — goods received back ({data?.received.length ?? 0} rows)
          </header>
          <table className="w-full">
            <thead className="bg-slate-100 border-b border-slate-300 text-left">
              <tr>
                <th className="px-2 py-1.5 font-bold">Job worker</th>
                <th className="px-2 py-1.5 font-bold">Original challan</th>
                <th className="px-2 py-1.5 font-bold">Their challan</th>
                <th className="px-2 py-1.5 font-bold">HSN</th>
                <th className="px-2 py-1.5 font-bold text-right">Sent</th>
                <th className="px-2 py-1.5 font-bold text-right">Received</th>
                <th className="px-2 py-1.5 font-bold text-right">Shortfall</th>
              </tr>
            </thead>
            <tbody>
              {(data?.received ?? []).slice(0, 200).map((r, i) => (
                <tr key={`${r.original_challan_no}-${i}`} className="border-b border-slate-100">
                  <td className="px-2 py-1">{r.job_worker}</td>
                  <td className="px-2 py-1 font-mono">
                    {r.original_challan_no}
                    <span className="text-slate-400 ml-1">{r.original_challan_date}</span>
                  </td>
                  <td className="px-2 py-1 font-mono">{r.jobworker_challan_no}</td>
                  <td className="px-2 py-1 font-mono">{r.hsn_code}</td>
                  <td className="px-2 py-1 text-right font-mono">{num(r.sent_qty)}</td>
                  <td className="px-2 py-1 text-right font-mono">{num(r.qty)}</td>
                  <td className="px-2 py-1 text-right font-mono text-amber-800">{num(r.loss_qty)}</td>
                </tr>
              ))}
              {(data?.received ?? []).length === 0 && !loading && (
                <tr><td colSpan={7} className="px-2 py-5 text-center text-slate-400">
                  Nothing received back in {period}
                </td></tr>
              )}
            </tbody>
          </table>
        </section>

        <section className="bg-white rounded border border-[#b8c9dd]">
          <header className="px-3 py-2 border-b border-slate-200 font-bold text-blue-900">
            Still lying at the job worker ({data?.pending.length ?? 0})
          </header>
          <table className="w-full">
            <thead className="bg-slate-100 border-b border-slate-300 text-left">
              <tr>
                <th className="px-2 py-1.5 font-bold">Job worker</th>
                <th className="px-2 py-1.5 font-bold">Challan</th>
                <th className="px-2 py-1.5 font-bold">Sent on</th>
                <th className="px-2 py-1.5 font-bold text-right">Pieces</th>
                <th className="px-2 py-1.5 font-bold text-right">Qty</th>
                <th className="px-2 py-1.5 font-bold text-right">Days out</th>
              </tr>
            </thead>
            <tbody>
              {(data?.pending ?? []).slice(0, 200).map(r => (
                <tr key={r.challan_no}
                  className={`border-b border-slate-100 ${r.beyond_one_year ? 'bg-red-50' : ''}`}>
                  <td className="px-2 py-1">{r.job_worker}</td>
                  <td className="px-2 py-1 font-mono">{r.challan_no}</td>
                  <td className="px-2 py-1">{r.challan_date}</td>
                  <td className="px-2 py-1 text-right font-mono">{r.pieces}</td>
                  <td className="px-2 py-1 text-right font-mono">{num(r.qty)}</td>
                  <td className={`px-2 py-1 text-right font-mono ${r.beyond_one_year ? 'text-red-700 font-bold' : ''}`}>
                    {r.days_out}
                  </td>
                </tr>
              ))}
              {(data?.pending ?? []).length === 0 && !loading && (
                <tr><td colSpan={6} className="px-2 py-5 text-center text-slate-400">
                  Everything sent out has come back
                </td></tr>
              )}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
};
