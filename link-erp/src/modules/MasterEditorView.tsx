import React, { useEffect, useState } from 'react';
import { ToolbarRibbon } from '../components/ToolbarRibbon';
import { useApi, useSubmit } from '../lib/useApi';
import { AlertTriangle, CheckCircle2, Search } from 'lucide-react';

/**
 * Every master is a searchable list plus a field form. Declaring the fields
 * beats writing one module per master — the legacy system has fifteen.
 */
type FieldType = 'text' | 'number' | 'checkbox' | 'select' | 'ref';

interface Field {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  span?: number;
  options?: string[];
  /** For `ref`: the resource to load options from. */
  from?: string;
  uppercase?: boolean;
}

interface MasterSpec {
  title: string;
  path: string;
  listColumns: { key: string; label: string }[];
  fields: Field[];
  blank: Record<string, unknown>;
}

export const MASTERS: Record<string, MasterSpec> = {
  ledgers: {
    title: 'Ledger — Account',
    path: '/ledgers',
    listColumns: [
      { key: 'code', label: 'Code' }, { key: 'name', label: 'Account Name' },
      { key: 'gstin', label: 'GSTIN' }, { key: 'gst_reg_type', label: 'Reg.' }
    ],
    fields: [
      { key: 'code', label: 'Code', type: 'text', required: true, span: 2 },
      { key: 'name', label: 'Account Name', type: 'text', required: true, span: 6 },
      { key: 'alias', label: 'Alias', type: 'text', span: 4 },
      { key: 'control_account_id', label: 'Control A/c', type: 'ref', from: '/control-accounts', required: true, span: 6 },
      { key: 'gstin', label: 'GSTIN', type: 'text', span: 3, uppercase: true },
      { key: 'pan', label: 'PAN', type: 'text', span: 3, uppercase: true },
      { key: 'gst_reg_type', label: 'GST Registration', type: 'select', span: 3,
        options: ['regular', 'composition', 'unregistered', 'sez', 'overseas'] },
      { key: 'credit_days', label: 'Credit Days', type: 'number', span: 2 },
      { key: 'credit_limit', label: 'Credit Limit', type: 'number', span: 3 },
      { key: 'opening_balance', label: 'Opening Balance', type: 'number', span: 4 },
      { key: 'is_msme', label: 'MSME', type: 'checkbox', span: 2 },
      { key: 'auto_tds_tcs', label: 'Auto TDS/TCS', type: 'checkbox', span: 2 },
      { key: 'rcm_applicable', label: 'RCM Applicable', type: 'checkbox', span: 2 },
      { key: 'is_active', label: 'In Use', type: 'checkbox', span: 2 }
    ],
    blank: {
      code: '', name: '', alias: '', control_account_id: '', gstin: '', pan: '',
      gst_reg_type: 'unregistered', credit_days: 0, credit_limit: 0,
      opening_balance: 0, is_msme: false, auto_tds_tcs: false,
      rcm_applicable: false, is_active: true
    }
  },
  qualities: {
    title: 'Quality Master',
    path: '/qualities',
    listColumns: [
      { key: 'code', label: 'Code' }, { key: 'name', label: 'Quality' },
      { key: 'width_cms', label: 'Width' }, { key: 'hsn_code', label: 'HSN' }
    ],
    fields: [
      { key: 'code', label: 'Code', type: 'text', required: true, span: 2 },
      { key: 'name', label: 'Quality Name', type: 'text', required: true, span: 5 },
      { key: 'division', label: 'Division', type: 'select', span: 5,
        options: ['Shirting', 'Suiting', 'Uniforms', 'Others'] },
      { key: 'construction', label: 'Construction', type: 'text', span: 6 },
      { key: 'selvedge_line', label: 'Selvedge Line', type: 'text', span: 6 },
      { key: 'width_cms', label: 'Width (cms)', type: 'number', span: 3 },
      { key: 'bill_by', label: 'Bill By', type: 'select', span: 3,
        options: ['meters', 'pcs', 'weight'] },
      { key: 'hsn_code', label: 'HSN Code', type: 'ref', from: '/hsn-codes', required: true, span: 4 },
      { key: 'is_active', label: 'In Use', type: 'checkbox', span: 2 }
    ],
    blank: {
      code: '', name: '', construction: '', selvedge_line: '', width_cms: 147,
      bill_by: 'meters', hsn_code: '', division: 'Shirting', is_active: true
    }
  },
  grades: {
    title: 'Grade Master',
    path: '/grades',
    listColumns: [{ key: 'code', label: 'Code' }, { key: 'name', label: 'Grade' }],
    fields: [
      { key: 'code', label: 'Code', type: 'text', required: true, span: 3, uppercase: true },
      { key: 'name', label: 'Grade Name', type: 'text', required: true, span: 6 },
      { key: 'sort_order', label: 'Sort', type: 'number', span: 3 }
    ],
    blank: { code: '', name: '', sort_order: 0 }
  },
  units: {
    title: 'Unit Master',
    path: '/units',
    listColumns: [{ key: 'code', label: 'Code' }, { key: 'name', label: 'Unit' }],
    fields: [
      { key: 'code', label: 'Code', type: 'text', required: true, span: 3, uppercase: true },
      { key: 'name', label: 'Name', type: 'text', required: true, span: 5 },
      { key: 'uqc', label: 'UQC (for GST returns)', type: 'text', required: true, span: 4, uppercase: true }
    ],
    blank: { code: '', name: '', uqc: '' }
  },
  widths: {
    title: 'Width Master',
    path: '/widths',
    listColumns: [{ key: 'code', label: 'Code' }, { key: 'cms', label: 'CMS' }],
    fields: [
      { key: 'code', label: 'Code', type: 'text', required: true, span: 3 },
      { key: 'cms', label: 'Width (cms)', type: 'number', required: true, span: 4 },
      { key: 'inches', label: 'Width (inches)', type: 'number', span: 4 }
    ],
    blank: { code: '', cms: 147, inches: 58 }
  },
  racks: {
    title: 'Rack Master',
    path: '/racks',
    listColumns: [{ key: 'code', label: 'Code' }, { key: 'name', label: 'Rack' }],
    fields: [
      { key: 'code', label: 'Code', type: 'text', required: true, span: 3, uppercase: true },
      { key: 'name', label: 'Name', type: 'text', required: true, span: 5 },
      { key: 'location', label: 'Godown / location', type: 'text', span: 4 }
    ],
    blank: { code: '', name: '', location: '' }
  },
  'bank-accounts': {
    title: 'Bank Accounts',
    path: '/bank-accounts',
    listColumns: [{ key: 'bank_name', label: 'Bank' }, { key: 'account_no', label: 'Account' }],
    fields: [
      { key: 'ledger_id', label: 'Ledger', type: 'ref', from: '/ledgers', required: true, span: 5 },
      { key: 'bank_name', label: 'Bank Name', type: 'text', required: true, span: 4 },
      { key: 'account_no', label: 'Account No.', type: 'text', required: true, span: 3 },
      { key: 'ifsc', label: 'IFSC', type: 'text', span: 3, uppercase: true },
      { key: 'branch', label: 'Branch', type: 'text', span: 5 },
      { key: 'is_default', label: 'Default account', type: 'checkbox', span: 3 }
    ],
    blank: { ledger_id: '', bank_name: '', account_no: '', ifsc: '', branch: '', is_default: false }
  },
  'hsn-codes': {
    title: 'HSN / SAC Master',
    path: '/hsn-codes',
    listColumns: [
      { key: 'code', label: 'HSN/SAC' }, { key: 'description', label: 'Description' },
      { key: 'gst_rate', label: 'Rate %' }
    ],
    fields: [
      { key: 'code', label: 'HSN / SAC Code', type: 'text', required: true, span: 3 },
      { key: 'description', label: 'Description', type: 'text', required: true, span: 6 },
      { key: 'gst_rate', label: 'GST Rate %', type: 'select', span: 3,
        options: ['0', '0.25', '3', '5', '12', '18', '28'] },
      { key: 'is_service', label: 'Is a service', type: 'checkbox', span: 3 }
    ],
    blank: { code: '', description: '', gst_rate: 5, is_service: false }
  }
};

export const MasterEditorView: React.FC<{ master: keyof typeof MASTERS }> = ({ master }) => {
  const spec = MASTERS[master]!;
  const [form, setForm] = useState<Record<string, any>>(spec.blank);
  const [search, setSearch] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  const list = useApi<any[]>(`${spec.path}?q=${encodeURIComponent(search)}`, [search]);
  const { submit, busy, error } = useSubmit<unknown, any>(spec.path);

  // Switching masters must not leave the previous master's fields in the form.
  useEffect(() => {
    setForm(spec.blank);
    setSearch('');
    setNotice(null);
  }, [master]);

  const refFrom = [...new Set(spec.fields.filter(f => f.type === 'ref').map(f => f.from!))];
  const refA = useApi<any[]>(refFrom[0] ?? null);
  const refB = useApi<any[]>(refFrom[1] ?? null);
  const refData = (path?: string) =>
    (path === refFrom[0] ? refA.data : path === refFrom[1] ? refB.data : []) ?? [];

  const save = async () => {
    const missing = spec.fields.filter(f => f.required && !String(form[f.key] ?? '').trim());
    if (missing.length > 0) {
      setNotice(`required: ${missing.map(m => m.label).join(', ')}`);
      return;
    }
    const out = await submit(form);
    if (out) {
      setNotice(`${form.name ?? form.code} saved`);
      list.reload();
    }
  };

  return (
    <div className="flex flex-col h-full bg-[#ecf1f7] text-slate-800 text-xs">
      <ToolbarRibbon
        title={spec.title}
        onSave={save}
        onNew={() => { setForm(spec.blank); setNotice(null); }}
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

      <div className="flex-1 overflow-hidden flex">
        <aside className="w-80 border-r border-[#b8c9dd] bg-white flex flex-col">
          <div className="p-2 border-b border-slate-200 flex items-center gap-1.5">
            <Search className="w-3.5 h-3.5 text-slate-400" />
            <input value={search} onChange={e => setSearch(e.target.value)}
                   placeholder="Search…" className="erp-input w-full" />
          </div>
          <div className="flex-1 overflow-y-auto">
            <table className="w-full">
              <thead className="bg-slate-100 sticky top-0">
                <tr>
                  {spec.listColumns.map(c => (
                    <th key={c.key} className="px-2 py-1 text-left font-bold">{c.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(list.data ?? []).map((row, i) => (
                  <tr key={row.id ?? row.code ?? i}
                      onClick={() => { setForm({ ...spec.blank, ...row }); setNotice(null); }}
                      className={`border-b border-slate-100 cursor-pointer hover:bg-blue-50 ${
                        form.code === row.code ? 'bg-blue-100' : ''
                      }`}>
                    {spec.listColumns.map(c => (
                      <td key={c.key} className="px-2 py-1">{String(row[c.key] ?? '')}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {list.loading && <p className="p-3 text-slate-400">Loading…</p>}
            {!list.loading && (list.data ?? []).length === 0 && (
              <p className="p-3 text-slate-400">No records</p>
            )}
          </div>
        </aside>

        <div className="flex-1 overflow-y-auto p-4">
          <div className="bg-white rounded border border-[#b8c9dd] p-4 max-w-5xl">
            <div className="grid grid-cols-12 gap-3">
              {spec.fields.map(f => (
                <div key={f.key} className={`col-span-${f.span ?? 3}`}
                     style={{ gridColumn: `span ${f.span ?? 3} / span ${f.span ?? 3}` }}>
                  <label className={`erp-label block ${f.required ? 'text-red-700 font-bold' : ''}`}
                         htmlFor={f.key}>
                    {f.required ? '* ' : ''}{f.label}
                  </label>

                  {f.type === 'checkbox' ? (
                    <label className="flex items-center gap-2 h-7 cursor-pointer font-medium">
                      <input id={f.key} type="checkbox" checked={!!form[f.key]}
                             onChange={e => setForm({ ...form, [f.key]: e.target.checked })}
                             className="w-4 h-4 rounded" />
                      <span>{form[f.key] ? 'Yes' : 'No'}</span>
                    </label>
                  ) : f.type === 'select' ? (
                    <select id={f.key} value={String(form[f.key] ?? '')}
                            onChange={e => setForm({ ...form, [f.key]: e.target.value })}
                            className="erp-input w-full">
                      {f.options!.map(o => <option key={o} value={o}>{o}</option>)}
                    </select>
                  ) : f.type === 'ref' ? (
                    <select id={f.key} value={String(form[f.key] ?? '')}
                            onChange={e => setForm({ ...form, [f.key]: e.target.value })}
                            className="erp-input w-full">
                      <option value="">— select —</option>
                      {refData(f.from).map(o => (
                        <option key={o.id ?? o.code} value={o.id ?? o.code}>
                          {o.name ?? o.description ?? o.code}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      id={f.key}
                      type={f.type === 'number' ? 'number' : 'text'}
                      value={String(form[f.key] ?? '')}
                      onChange={e => setForm({
                        ...form,
                        [f.key]: f.type === 'number'
                          ? Number(e.target.value)
                          : f.uppercase ? e.target.value.toUpperCase() : e.target.value
                      })}
                      className={`erp-input w-full ${f.uppercase ? 'font-mono uppercase' : ''}`}
                    />
                  )}
                </div>
              ))}
            </div>

            <div className="flex justify-end pt-4 mt-3 border-t border-slate-200">
              <button onClick={save} disabled={busy}
                      className="erp-btn erp-btn-primary font-bold px-5 disabled:opacity-60">
                {busy ? 'Saving…' : 'Save Record'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
