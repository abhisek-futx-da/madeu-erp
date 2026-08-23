import React, { useState } from 'react';
import { AlertTriangle, CheckCircle2, Download, FileSpreadsheet, ShieldCheck, Upload } from 'lucide-react';
import { ToolbarRibbon } from '../components/ToolbarRibbon';
import { api } from '../lib/api';
import { parseCsv } from '../lib/csv';
import { useApi } from '../lib/useApi';

const RESOURCES = [
  ['ledgers', 'Ledger accounts'], ['qualities', 'Quality master'], ['hsn-codes', 'HSN / SAC master'],
  ['grades', 'Grade master'], ['units', 'Unit master'], ['widths', 'Width master'], ['racks', 'Rack master']
] as const;

interface PreviewRow {
  row_no: number;
  raw_data: Record<string, unknown>;
  normalized_data: Record<string, unknown>;
  action: 'insert' | 'update' | 'error';
  errors: string[];
}
interface Preview {
  id: string; totalRows: number; validRows: number; errorRows: number; rows: PreviewRow[];
}
interface ImportBatch {
  id: string; resource: string; filename: string; status: string; total_rows: number;
  valid_rows: number; error_rows: number; created_at: string; applied_at: string | null;
}

export const OnboardingView: React.FC = () => {
  const [resource, setResource] = useState<(typeof RESOURCES)[number][0]>('ledgers');
  const [filename, setFilename] = useState('');
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const history = useApi<ImportBatch[]>('/onboarding/imports');

  const chooseFile = async (file?: File) => {
    setError(null);
    setNotice(null);
    setPreview(null);
    setRows([]);
    if (!file) { setFilename(''); return; }
    try {
      if (file.size > 1_800_000) throw new Error('file is too large; split it into batches of 2,000 rows');
      const parsed = parseCsv(await file.text());
      if (parsed.rows.length > 2000) throw new Error('this file has more than 2,000 data rows');
      setFilename(file.name);
      setRows(parsed.rows);
      setNotice(`${parsed.rows.length} row(s) loaded locally. Preview them before anything is changed.`);
    } catch (caught) {
      setFilename(file.name);
      setError(caught instanceof Error ? caught.message : 'could not read this CSV');
    }
  };

  const createPreview = async () => {
    if (!filename || rows.length === 0) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const result = await api.post<Preview>('/onboarding/imports/preview', { resource, filename, rows });
      setPreview(result);
      setNotice(result.errorRows === 0
        ? `${result.validRows} row(s) are clean. Review the decisions, then apply.`
        : `${result.errorRows} row(s) were rejected. Nothing has been changed.`);
      history.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'preview failed');
    } finally { setBusy(false); }
  };

  const apply = async () => {
    if (!preview || preview.errorRows > 0) return;
    if (!window.confirm(`Apply all ${preview.validRows} rows to the live ${resource} master?`)) return;
    setBusy(true); setError(null);
    try {
      const result = await api.post<{ appliedRows: number }>(`/onboarding/imports/${preview.id}/apply`, {});
      setNotice(`${result.appliedRows} row(s) applied in one complete transaction.`);
      setPreview(null); setRows([]); setFilename('');
      history.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'apply failed; no rows were changed');
    } finally { setBusy(false); }
  };

  return (
    <div className="flex flex-col h-full bg-[#ecf1f7] text-slate-800 text-xs">
      <ToolbarRibbon title="Data Migration & Onboarding" onPrint={() => window.print()} />
      <div className="flex-1 overflow-auto p-4 space-y-4">
        <div className="bg-blue-50 border border-blue-300 rounded p-3 flex gap-3 max-w-6xl">
          <ShieldCheck className="w-5 h-5 text-blue-800 shrink-0" />
          <div>
            <p className="font-bold text-blue-950">Preview first. Apply once. Never half-import.</p>
            <p className="text-blue-900 mt-1">Download the Excel-compatible CSV template, fill it, and upload it here. Every row is validated against this company’s live masters. Only the owner can apply a completely clean batch.</p>
          </div>
        </div>

        {(notice || error) && <div role="status" className={`max-w-6xl px-3 py-2 rounded flex items-center gap-2 font-semibold ${error ? 'bg-red-600 text-white' : 'bg-emerald-600 text-white'}`}>
          {error ? <AlertTriangle className="w-4 h-4" /> : <CheckCircle2 className="w-4 h-4" />}
          {error ?? notice}
        </div>}

        <section className="bg-white border border-[#b8c9dd] rounded p-4 max-w-6xl" aria-labelledby="import-heading">
          <h2 id="import-heading" className="font-bold text-sm text-blue-950 mb-3">1. Prepare and preview</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
            <label><span className="erp-label block">Master to import</span>
              <select value={resource} onChange={event => { setResource(event.target.value as typeof resource); setPreview(null); setRows([]); setFilename(''); }} className="erp-input w-full">
                {RESOURCES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
              </select>
            </label>
            <button type="button" onClick={() => void api.download(`/onboarding/templates/${resource}`, `${resource}-template.csv`).catch(caught => setError(caught instanceof Error ? caught.message : 'template download failed'))} className="erp-btn min-h-9 justify-center">
              <Download className="w-4 h-4" /> Download CSV template
            </button>
            <label className="erp-btn min-h-9 justify-center cursor-pointer">
              <FileSpreadsheet className="w-4 h-4" /> {filename || 'Choose completed CSV'}
              <input type="file" accept=".csv,text/csv" className="sr-only" onChange={event => void chooseFile(event.target.files?.[0])} />
            </label>
          </div>
          <div className="mt-4 flex items-center gap-3">
            <button type="button" disabled={busy || rows.length === 0} onClick={() => void createPreview()} className="erp-btn erp-btn-primary font-bold disabled:opacity-40">
              <Upload className="w-4 h-4" /> {busy ? 'Checking…' : `Preview ${rows.length || ''} row(s)`}
            </button>
            <span className="text-slate-500">No live master is changed during preview.</span>
          </div>
        </section>

        {preview && <section className="bg-white border border-[#b8c9dd] rounded max-w-6xl overflow-hidden" aria-labelledby="preview-heading">
          <div className="p-3 bg-slate-50 border-b border-slate-200 flex flex-wrap items-center gap-3">
            <h2 id="preview-heading" className="font-bold text-sm text-blue-950">2. Review decisions</h2>
            <span className="ml-auto font-mono">{preview.validRows} valid · {preview.errorRows} rejected</span>
            {preview.errorRows > 0 && <button type="button" onClick={() => void api.download(`/onboarding/imports/${preview.id}/rejections`, 'import-rejections.csv')} className="erp-btn">
              <Download className="w-3.5 h-3.5" /> Rejection report
            </button>}
            <button type="button" disabled={busy || preview.errorRows > 0} onClick={() => void apply()} className="erp-btn erp-btn-primary font-bold disabled:opacity-40">
              Apply clean batch
            </button>
          </div>
          <div className="overflow-auto max-h-80">
            <table className="w-full">
              <thead className="sticky top-0 bg-slate-100 text-left"><tr><th className="px-2 py-1">CSV row</th><th className="px-2 py-1">Decision</th><th className="px-2 py-1">Key</th><th className="px-2 py-1">Explanation</th></tr></thead>
              <tbody>{preview.rows.map(row => <tr key={row.row_no} className="border-t border-slate-100">
                <td className="px-2 py-1 font-mono">{row.row_no}</td>
                <td className={`px-2 py-1 font-bold uppercase ${row.action === 'error' ? 'text-red-700' : row.action === 'update' ? 'text-amber-700' : 'text-emerald-700'}`}>{row.action}</td>
                <td className="px-2 py-1 font-mono">{String(row.normalized_data.code ?? row.raw_data.code ?? '')}</td>
                <td className="px-2 py-1">{row.errors.join('; ') || (row.action === 'update' ? 'Existing code will be updated' : 'New code will be inserted')}</td>
              </tr>)}</tbody>
            </table>
          </div>
        </section>}

        <section className="bg-white border border-[#b8c9dd] rounded max-w-6xl overflow-hidden" aria-labelledby="history-heading">
          <h2 id="history-heading" className="p-3 bg-slate-50 border-b border-slate-200 font-bold text-sm text-blue-950">Import history</h2>
          <table className="w-full"><thead className="bg-slate-100 text-left"><tr><th className="px-2 py-1">When</th><th className="px-2 py-1">File</th><th className="px-2 py-1">Master</th><th className="px-2 py-1">Rows</th><th className="px-2 py-1">Rejected</th><th className="px-2 py-1">Status</th></tr></thead>
            <tbody>{(history.data ?? []).map(batch => <tr key={batch.id} className="border-t border-slate-100"><td className="px-2 py-1">{new Date(batch.created_at).toLocaleString('en-GB')}</td><td className="px-2 py-1">{batch.filename}</td><td className="px-2 py-1">{batch.resource}</td><td className="px-2 py-1 font-mono">{batch.total_rows}</td><td className="px-2 py-1 font-mono">{batch.error_rows}</td><td className="px-2 py-1 font-bold uppercase">{batch.status}</td></tr>)}</tbody>
          </table>
          {!history.loading && (history.data ?? []).length === 0 && <p className="p-4 text-slate-400">No imports yet.</p>}
        </section>
      </div>
    </div>
  );
};
