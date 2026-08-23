import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Save, Trash2 } from 'lucide-react';
import { ToolbarRibbon } from '../components/ToolbarRibbon';
import { api, ApiError } from '../lib/api';
import { useApi } from '../lib/useApi';

type Tab = 'books' | 'controls' | 'statutory';
interface Year { label: string; status: string }
interface Ledger { id: string; code: string; name: string }
interface Quality { id: string; name: string }
interface Opening {
  ledger_id: string; code: string; name: string; control_account: string;
  nature: string; debit: number; credit: number;
}
interface Rule { doc_type: string; min_amount: number; approver_role: string; is_active: boolean }
interface Config {
  settings: Array<{ key: string; value: unknown }>;
  shrinkage: Array<{ id: string; quality_id: string | null; quality: string | null;
    process_house_id: string | null; process_house: string | null;
    warn_pct: number; max_pct: number; gain_pct: number }>;
  brokerage: Array<{ id: string; broker_id: string; broker: string; party_id: string | null;
    party: string | null; doc_type: string; basis: string; rate: number }>;
  rates: Array<{ id: string; party_id: string; party: string; quality_id: string | null;
    quality: string | null; kind: 'purchase' | 'sales'; rate: number;
    valid_from: string; valid_to: string | null }>;
  tdsSections: Array<{ code: string; kind: string; description: string; rate: number;
    rate_no_pan: number; threshold: number; basis: string; applies_to: string }>;
  series: Array<{ doc_type: string; fy_label: string; prefix: string; next_number: number }>;
  ledgerTds: Array<{ ledger_id: string; ledger: string; tds_section: string | null }>;
  audit: Array<{ area: string; event: string; occurred_at: string }>;
}

const money = (n: number) => `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
const input = 'erp-input w-full min-h-11';
const labelled = 'block text-[11px] font-bold text-slate-700 mb-1';

export const CompanySetupView: React.FC = () => {
  const years = useApi<Year[]>('/financial-years');
  const ledgers = useApi<Ledger[]>('/ledgers?limit=500');
  const qualities = useApi<Quality[]>('/qualities?limit=500');
  const rules = useApi<Rule[]>('/approval-rules');
  const config = useApi<Config>('/configuration');
  const [tab, setTab] = useState<Tab>('books');
  const [fy, setFy] = useState('');
  const openings = useApi<Opening[]>(fy ? `/opening-balances/${fy}` : null, [fy]);
  const [openingRows, setOpeningRows] = useState<Opening[]>([]);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!fy && years.data?.length) setFy(years.data.find(y => y.status === 'open')?.label ?? years.data[0].label);
  }, [fy, years.data]);
  useEffect(() => { if (openings.data) setOpeningRows(openings.data.map(r => ({ ...r }))); }, [openings.data]);

  const run = async (job: () => Promise<unknown>, success: string) => {
    setBusy(true); setNotice(null);
    try { await job(); setNotice({ kind: 'ok', text: success }); config.reload(); rules.reload(); }
    catch (e) { setNotice({ kind: 'error', text: e instanceof ApiError ? e.message : String(e) }); }
    finally { setBusy(false); }
  };

  const totals = useMemo(() => openingRows.reduce((t, r) => ({
    debit: t.debit + Number(r.debit || 0), credit: t.credit + Number(r.credit || 0)
  }), { debit: 0, credit: 0 }), [openingRows]);
  const openingDrift = Math.round((totals.debit - totals.credit) * 100) / 100;

  const saveOpenings = () => run(async () => {
    await api.post(`/opening-balances/${fy}`, {
      entries: openingRows.map(r => ({ ledgerId: r.ledger_id,
        debit: Number(r.debit || 0), credit: Number(r.credit || 0) }))
    });
    openings.reload();
  }, `Opening balances for ${fy} saved and audited`);

  return (
    <main className="flex flex-col h-full bg-[#ecf1f7] text-slate-800 text-xs" aria-labelledby="setup-title">
      <ToolbarRibbon title="Company Setup & Controls" onPrint={() => window.print()} />
      <h1 id="setup-title" className="sr-only">Company Setup and Accounting Controls</h1>
      {notice && (
        <div role={notice.kind === 'error' ? 'alert' : 'status'}
          className={`px-4 py-2 flex items-center gap-2 font-semibold ${notice.kind === 'error' ? 'bg-red-700 text-white' : 'bg-emerald-700 text-white'}`}>
          {notice.kind === 'error' ? <AlertTriangle className="w-4 h-4" /> : <CheckCircle2 className="w-4 h-4" />}
          {notice.text}
        </div>
      )}
      <nav aria-label="Setup sections" className="bg-white border-b border-slate-300 px-3 py-2 flex flex-wrap gap-2">
        {([['books', 'Opening Books'], ['controls', 'Commercial Controls'], ['statutory', 'Statutory & Numbering']] as const).map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)} aria-current={tab === id ? 'page' : undefined}
            className={`erp-btn min-h-11 px-4 ${tab === id ? 'erp-btn-primary' : ''}`}>{label}</button>
        ))}
      </nav>
      <div className="flex-1 overflow-auto p-3 max-w-7xl w-full mx-auto">
        {tab === 'books' && <OpeningBooks years={years.data ?? []} fy={fy} setFy={setFy}
          rows={openingRows} setRows={setOpeningRows} totals={totals} drift={openingDrift}
          loading={openings.loading} busy={busy} onSave={saveOpenings} />}
        {tab === 'controls' && <CommercialControls config={config.data} rules={rules.data ?? []}
          ledgers={ledgers.data ?? []} qualities={qualities.data ?? []} busy={busy} run={run} />}
        {tab === 'statutory' && <StatutoryControls config={config.data} ledgers={ledgers.data ?? []}
          busy={busy} run={run} />}
      </div>
    </main>
  );
};

function OpeningBooks({ years, fy, setFy, rows, setRows, totals, drift, loading, busy, onSave }: {
  years: Year[]; fy: string; setFy: (v: string) => void; rows: Opening[];
  setRows: React.Dispatch<React.SetStateAction<Opening[]>>;
  totals: { debit: number; credit: number }; drift: number; loading: boolean; busy: boolean; onSave: () => void;
}) {
  const change = (i: number, side: 'debit' | 'credit', value: number) => setRows(prev => prev.map((r, n) =>
    n === i ? { ...r, [side]: value, [side === 'debit' ? 'credit' : 'debit']: value > 0 ? 0 : r[side === 'debit' ? 'credit' : 'debit'] } : r));
  return <section className="space-y-3" aria-labelledby="opening-title">
    <div className="bg-white border border-[#b8c9dd] rounded p-4">
      <h2 id="opening-title" className="text-sm font-bold text-blue-950">CA-approved opening balances</h2>
      <p className="text-slate-600 mt-1">Enter explicit debit or credit values. They must balance exactly and lock after the first posted voucher.</p>
      <label className="block mt-3 max-w-xs"><span className={labelled}>Financial year</span>
        <select className={input} value={fy} onChange={e => setFy(e.target.value)}>
          {years.map(y => <option key={y.label} value={y.label}>{y.label} — {y.status}</option>)}
        </select>
      </label>
    </div>
    <div className="bg-white border border-[#b8c9dd] rounded overflow-x-auto">
      <table className="w-full min-w-[760px]">
        <thead className="bg-slate-100"><tr>
          <th className="text-left p-2">Code</th><th className="text-left p-2">Ledger</th>
          <th className="text-left p-2">Group</th><th className="text-right p-2">Debit</th><th className="text-right p-2">Credit</th>
        </tr></thead>
        <tbody>{rows.map((r, i) => <tr key={r.ledger_id} className="border-t">
          <td className="p-2 font-mono">{r.code}</td><td className="p-2">{r.name}</td><td className="p-2">{r.control_account}</td>
          <td className="p-2"><label><span className="sr-only">Debit opening for {r.name}</span><input aria-label={`Debit opening for ${r.name}`} type="number" min="0" step="0.01" className={`${input} text-right font-mono`} value={r.debit} onChange={e => change(i, 'debit', Number(e.target.value))} /></label></td>
          <td className="p-2"><label><span className="sr-only">Credit opening for {r.name}</span><input aria-label={`Credit opening for ${r.name}`} type="number" min="0" step="0.01" className={`${input} text-right font-mono`} value={r.credit} onChange={e => change(i, 'credit', Number(e.target.value))} /></label></td>
        </tr>)}</tbody>
        <tfoot className="bg-slate-100 font-bold"><tr><td colSpan={3} className="p-3 text-right">Totals</td>
          <td className="p-3 text-right font-mono">{money(totals.debit)}</td><td className="p-3 text-right font-mono">{money(totals.credit)}</td></tr></tfoot>
      </table>
      {!loading && rows.length === 0 && <p className="p-6 text-center text-slate-500">No balance-sheet ledgers are available.</p>}
    </div>
    <div className={`rounded border p-3 flex flex-wrap items-center gap-3 ${drift === 0 ? 'bg-emerald-50 border-emerald-300' : 'bg-red-50 border-red-300'}`}>
      <strong>{drift === 0 ? 'Opening trial balance is square.' : `Out by ${money(Math.abs(drift))}.`}</strong>
      <button disabled={busy || drift !== 0 || !fy} onClick={onSave} className="erp-btn erp-btn-primary min-h-11 ml-auto disabled:opacity-50"><Save className="w-4 h-4" />Save audited openings</button>
    </div>
  </section>;
}

function CommercialControls({ config, rules, ledgers, qualities, busy, run }: {
  config: Config | null; rules: Rule[]; ledgers: Ledger[]; qualities: Quality[]; busy: boolean;
  run: (job: () => Promise<unknown>, success: string) => Promise<void>;
}) {
  const setting = (key: string, fallback: unknown) => config?.settings.find(s => s.key === key)?.value ?? fallback;
  const [rounding, setRounding] = useState(String(setting('invoice.rounding', 'nearest_rupee')));
  const [credit, setCredit] = useState(Boolean(setting('credit.enforce_limit', true)));
  const [ruleRows, setRuleRows] = useState<Rule[]>([]);
  const [shrink, setShrink] = useState({ qualityId: '', processHouseId: '', warnPct: 8, maxPct: 12, gainPct: 1 });
  const [broker, setBroker] = useState({ brokerId: '', partyId: '', docType: 'sales_invoice', basis: 'percent_of_value', rate: 0 });
  const [rate, setRate] = useState({ partyId: '', qualityId: '', kind: 'sales' as 'purchase' | 'sales', rate: 0, validFrom: new Date().toISOString().slice(0, 10), validTo: '' });
  useEffect(() => {
    if (config) { setRounding(String(setting('invoice.rounding', 'nearest_rupee'))); setCredit(Boolean(setting('credit.enforce_limit', true))); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config]);
  useEffect(() => setRuleRows(rules.map(r => ({ ...r }))), [rules]);
  const updateRule = (i: number, patch: Partial<Rule>) => setRuleRows(v => v.map((r, n) => n === i ? { ...r, ...patch } : r));
  return <div className="space-y-4">
    <section className="bg-white border rounded p-4 space-y-3"><h2 className="font-bold text-sm text-blue-950">Company policies</h2>
      <div className="grid md:grid-cols-2 gap-3">
        <label><span className={labelled}>Invoice rounding</span><select className={input} value={rounding} onChange={e => setRounding(e.target.value)}><option value="nearest_rupee">Nearest rupee</option><option value="none">No rounding</option></select></label>
        <label className="flex items-center gap-2 min-h-11 mt-5"><input type="checkbox" checked={credit} onChange={e => setCredit(e.target.checked)} />Enforce party credit limits</label>
      </div>
      <button disabled={busy} className="erp-btn erp-btn-primary min-h-11" onClick={() => run(() => api.post('/configuration/settings', { invoiceRounding: rounding, enforceCreditLimit: credit }), 'Company policies saved')}>Save policies</button>
    </section>
    <section className="bg-white border rounded p-4"><h2 className="font-bold text-sm text-blue-950 mb-2">Maker-checker approval limits</h2>
      <div className="overflow-x-auto"><table className="w-full min-w-[650px]"><thead><tr><th className="text-left p-2">Document</th><th className="p-2">Above amount</th><th className="p-2">Approver</th><th className="p-2">Active</th><th></th></tr></thead><tbody>
        {ruleRows.map((r, i) => <tr key={r.doc_type} className="border-t"><td className="p-2">{r.doc_type.replaceAll('_', ' ')}</td>
          <td className="p-2"><input aria-label={`Approval amount for ${r.doc_type}`} className={`${input} text-right`} type="number" min="0" value={r.min_amount} onChange={e => updateRule(i, { min_amount: Number(e.target.value) })} /></td>
          <td className="p-2"><select aria-label={`Approver for ${r.doc_type}`} className={input} value={r.approver_role} onChange={e => updateRule(i, { approver_role: e.target.value })}>{['owner','accounts','purchase','sales','store'].map(v => <option key={v}>{v}</option>)}</select></td>
          <td className="p-2 text-center"><input aria-label={`Enable approval for ${r.doc_type}`} type="checkbox" checked={r.is_active} onChange={e => updateRule(i, { is_active: e.target.checked })} /></td>
          <td className="p-2"><button className="erp-btn min-h-11" disabled={busy} onClick={() => run(() => api.post('/approval-rules', { docType: r.doc_type, minAmount: r.min_amount, approverRole: r.approver_role, isActive: r.is_active }), `${r.doc_type} approval saved`)}>Save</button></td></tr>)}
      </tbody></table></div>
    </section>
    <section className="bg-white border rounded p-4 space-y-3"><h2 className="font-bold text-sm text-blue-950">Shrinkage tolerances</h2>
      <div className="grid md:grid-cols-5 gap-2">
        <label><span className={labelled}>Quality (blank = all)</span><select className={input} value={shrink.qualityId} onChange={e => setShrink({ ...shrink, qualityId: e.target.value })}><option value="">All qualities</option>{qualities.map(q => <option key={q.id} value={q.id}>{q.name}</option>)}</select></label>
        <label><span className={labelled}>Process house (blank = all)</span><select className={input} value={shrink.processHouseId} onChange={e => setShrink({ ...shrink, processHouseId: e.target.value })}><option value="">All process houses</option>{ledgers.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
        {(['warnPct','maxPct','gainPct'] as const).map(k => <label key={k}><span className={labelled}>{k === 'warnPct' ? 'Warn %' : k === 'maxPct' ? 'Maximum %' : 'Allowed gain %'}</span><input className={input} type="number" min="0" max="100" step="0.01" value={shrink[k]} onChange={e => setShrink({ ...shrink, [k]: Number(e.target.value) })} /></label>)}
      </div>
      <button className="erp-btn erp-btn-primary min-h-11" disabled={busy} onClick={() => run(() => api.post('/configuration/shrinkage', { ...shrink, qualityId: shrink.qualityId || null, processHouseId: shrink.processHouseId || null }), 'Shrinkage policy saved')}>Add policy</button>
      <div className="flex flex-wrap gap-2">{config?.shrinkage.map(s => <span key={s.id} className="border rounded bg-slate-50 px-3 py-2 flex items-center gap-2">{s.quality ?? 'All qualities'} / {s.process_house ?? 'All houses'}: {s.warn_pct}% warn, {s.max_pct}% max <button aria-label="Delete shrinkage policy" onClick={() => run(() => api.del(`/configuration/shrinkage/${s.id}`), 'Shrinkage policy deleted')}><Trash2 className="w-4 h-4 text-red-700" /></button></span>)}</div>
    </section>
    <section className="bg-white border rounded p-4 space-y-3"><h2 className="font-bold text-sm text-blue-950">Brokerage rules</h2>
      <div className="grid md:grid-cols-5 gap-2">
        <label><span className={labelled}>Broker</span><select className={input} value={broker.brokerId} onChange={e => setBroker({ ...broker, brokerId: e.target.value })}><option value="">Select</option>{ledgers.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
        <label><span className={labelled}>Party (optional)</span><select className={input} value={broker.partyId} onChange={e => setBroker({ ...broker, partyId: e.target.value })}><option value="">All parties</option>{ledgers.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
        <label><span className={labelled}>Document</span><select className={input} value={broker.docType} onChange={e => setBroker({ ...broker, docType: e.target.value })}><option value="sales_invoice">Sales invoice</option></select></label>
        <label><span className={labelled}>Basis</span><select className={input} value={broker.basis} onChange={e => setBroker({ ...broker, basis: e.target.value })}><option value="percent_of_value">% of value</option><option value="per_unit">Per unit</option><option value="flat">Flat</option></select></label>
        <label><span className={labelled}>Rate</span><input className={input} type="number" min="0" step="0.0001" value={broker.rate} onChange={e => setBroker({ ...broker, rate: Number(e.target.value) })} /></label>
      </div><button disabled={busy || !broker.brokerId} className="erp-btn erp-btn-primary min-h-11" onClick={() => run(() => api.post('/configuration/brokerage', { ...broker, partyId: broker.partyId || null }), 'Brokerage rule saved')}>Add rule</button>
      <div className="flex flex-wrap gap-2">{config?.brokerage.map(b => <span key={b.id} className="border rounded bg-slate-50 px-3 py-2 flex items-center gap-2">{b.broker} / {b.party ?? 'all'} / {b.doc_type}: {b.rate} {b.basis}<button aria-label="Delete brokerage rule" onClick={() => run(() => api.del(`/configuration/brokerage/${b.id}`), 'Brokerage rule deleted')}><Trash2 className="w-4 h-4 text-red-700" /></button></span>)}</div>
    </section>
    <section className="bg-white border rounded p-4 space-y-3"><h2 className="font-bold text-sm text-blue-950">Purchase and sales rate contracts</h2>
      <p className="text-slate-600">A quality-specific rate wins over an all-quality rate. Orders may still record a separately negotiated rate.</p>
      <div className="grid md:grid-cols-6 gap-2">
        <label><span className={labelled}>Party</span><select className={input} value={rate.partyId} onChange={e => setRate({ ...rate, partyId: e.target.value })}><option value="">Select</option>{ledgers.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
        <label><span className={labelled}>Quality (optional)</span><select className={input} value={rate.qualityId} onChange={e => setRate({ ...rate, qualityId: e.target.value })}><option value="">All qualities</option>{qualities.map(q => <option key={q.id} value={q.id}>{q.name}</option>)}</select></label>
        <label><span className={labelled}>Kind</span><select className={input} value={rate.kind} onChange={e => setRate({ ...rate, kind: e.target.value as 'purchase' | 'sales' })}><option value="purchase">Purchase</option><option value="sales">Sales</option></select></label>
        <label><span className={labelled}>Rate</span><input className={input} type="number" min="0" step="0.01" value={rate.rate} onChange={e => setRate({ ...rate, rate: Number(e.target.value) })} /></label>
        <label><span className={labelled}>Valid from</span><input className={input} type="date" value={rate.validFrom} onChange={e => setRate({ ...rate, validFrom: e.target.value })} /></label>
        <label><span className={labelled}>Valid to (optional)</span><input className={input} type="date" value={rate.validTo} onChange={e => setRate({ ...rate, validTo: e.target.value })} /></label>
      </div>
      <button disabled={busy || !rate.partyId || !rate.validFrom} className="erp-btn erp-btn-primary min-h-11" onClick={() => run(() => api.post('/configuration/rates', { ...rate, qualityId: rate.qualityId || null, validTo: rate.validTo || null }), 'Rate contract saved')}>Add rate contract</button>
      <div className="flex flex-wrap gap-2">{config?.rates.map(r => <span key={r.id} className="border rounded bg-slate-50 px-3 py-2 flex items-center gap-2">{r.party} / {r.quality ?? 'all qualities'} / {r.kind}: {money(Number(r.rate))} from {r.valid_from}{r.valid_to ? ` to ${r.valid_to}` : ''}<button aria-label="Delete rate contract" onClick={() => run(() => api.del(`/configuration/rates/${r.id}`), 'Rate contract deleted')}><Trash2 className="w-4 h-4 text-red-700" /></button></span>)}</div>
    </section>
  </div>;
}

function StatutoryControls({ config, ledgers, busy, run }: { config: Config | null; ledgers: Ledger[]; busy: boolean; run: (job: () => Promise<unknown>, success: string) => Promise<void> }) {
  const [tds, setTds] = useState({ code: '', kind: 'tds', description: '', rate: 0.1, rateNoPan: 5, threshold: 5000000, basis: 'excess_over_threshold', appliesTo: 'purchase' });
  const [assignment, setAssignment] = useState({ ledgerId: '', sectionCode: '' });
  const [prefixes, setPrefixes] = useState<Record<string, string>>({});
  useEffect(() => { if (config) setPrefixes(Object.fromEntries(config.series.map(s => [`${s.fy_label}|${s.doc_type}`, s.prefix]))); }, [config]);
  return <div className="space-y-4">
    <section className="bg-white border rounded p-4"><h2 className="font-bold text-sm text-blue-950 mb-2">Document numbering</h2><p className="text-slate-600 mb-3">Prefixes are editable; the next number is protected from accidental resets.</p>
      <div className="overflow-x-auto"><table className="w-full min-w-[680px]"><thead><tr><th className="text-left p-2">Year</th><th className="text-left p-2">Document</th><th className="text-left p-2">Prefix</th><th className="text-right p-2">Next</th><th></th></tr></thead><tbody>{config?.series.map(s => { const key = `${s.fy_label}|${s.doc_type}`; return <tr className="border-t" key={key}><td className="p-2">{s.fy_label}</td><td className="p-2">{s.doc_type}</td><td className="p-2"><input aria-label={`Prefix for ${s.doc_type} ${s.fy_label}`} className={input} value={prefixes[key] ?? ''} onChange={e => setPrefixes({ ...prefixes, [key]: e.target.value })} /></td><td className="p-2 text-right font-mono">{s.next_number}</td><td className="p-2"><button disabled={busy} className="erp-btn min-h-11" onClick={() => run(() => api.post('/configuration/document-series', { docType: s.doc_type, fyLabel: s.fy_label, prefix: prefixes[key] ?? '' }), `${s.doc_type} prefix saved`)}>Save</button></td></tr>; })}</tbody></table></div>
    </section>
    <section className="bg-white border rounded p-4 space-y-3"><h2 className="font-bold text-sm text-blue-950">CA-approved TDS sections</h2>
      <div className="grid md:grid-cols-4 gap-2">
        <label><span className={labelled}>Section code</span><input className={input} value={tds.code} onChange={e => setTds({ ...tds, code: e.target.value.toUpperCase() })} /></label>
        <label className="md:col-span-2"><span className={labelled}>Description</span><input className={input} value={tds.description} onChange={e => setTds({ ...tds, description: e.target.value })} /></label>
        <label><span className={labelled}>Applies to</span><select className={input} value={tds.appliesTo} onChange={e => setTds({ ...tds, appliesTo: e.target.value })}><option value="purchase">Purchases</option><option value="sales">Sales</option></select></label>
        <label><span className={labelled}>Normal rate %</span><input className={input} type="number" min="0" step="0.001" value={tds.rate} onChange={e => setTds({ ...tds, rate: Number(e.target.value) })} /></label>
        <label><span className={labelled}>No-PAN rate %</span><input className={input} type="number" min="0" step="0.001" value={tds.rateNoPan} onChange={e => setTds({ ...tds, rateNoPan: Number(e.target.value) })} /></label>
        <label><span className={labelled}>Threshold</span><input className={input} type="number" min="0" value={tds.threshold} onChange={e => setTds({ ...tds, threshold: Number(e.target.value) })} /></label>
        <label><span className={labelled}>Threshold basis</span><select className={input} value={tds.basis} onChange={e => setTds({ ...tds, basis: e.target.value })}><option value="excess_over_threshold">Excess over threshold</option><option value="full_once_crossed">Full amount once crossed</option></select></label>
      </div><button disabled={busy || !tds.code || !tds.description} className="erp-btn erp-btn-primary min-h-11" onClick={() => run(() => api.post('/configuration/tds-sections', tds), 'TDS section saved')}>Save TDS section</button>
      <div className="flex flex-wrap gap-2">{config?.tdsSections.map(s => <span className="border rounded bg-slate-50 px-3 py-2" key={s.code}>{s.code}: {s.rate}% after {money(Number(s.threshold))} — {s.description}</span>)}</div>
    </section>
    <section className="bg-white border rounded p-4 space-y-3"><h2 className="font-bold text-sm text-blue-950">Assign TDS to a party ledger</h2>
      <div className="grid md:grid-cols-2 gap-2 max-w-3xl"><label><span className={labelled}>Party ledger</span><select className={input} value={assignment.ledgerId} onChange={e => setAssignment({ ...assignment, ledgerId: e.target.value })}><option value="">Select</option>{ledgers.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
        <label><span className={labelled}>Section</span><select className={input} value={assignment.sectionCode} onChange={e => setAssignment({ ...assignment, sectionCode: e.target.value })}><option value="">No automatic TDS</option>{config?.tdsSections.map(s => <option key={s.code} value={s.code}>{s.code} — {s.description}</option>)}</select></label></div>
      <button disabled={busy || !assignment.ledgerId} className="erp-btn erp-btn-primary min-h-11" onClick={() => run(() => api.post('/configuration/ledger-tds', { ledgerId: assignment.ledgerId, sectionCode: assignment.sectionCode || null }), 'Party TDS assignment saved')}>Save assignment</button>
    </section>
    <section className="bg-white border rounded p-4"><h2 className="font-bold text-sm text-blue-950">Recent configuration audit</h2><ul className="mt-2 divide-y">{config?.audit.map((a, i) => <li className="py-2" key={`${a.occurred_at}-${i}`}>{new Date(a.occurred_at).toLocaleString('en-IN')} — <strong>{a.area}</strong> {a.event}</li>)}</ul></section>
  </div>;
}
