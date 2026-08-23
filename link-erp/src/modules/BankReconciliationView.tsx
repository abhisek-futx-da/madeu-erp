import React, { useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Link2, LockKeyhole, Upload } from 'lucide-react';
import { ToolbarRibbon } from '../components/ToolbarRibbon';
import { api, ApiError, type Session } from '../lib/api';
import { useApi } from '../lib/useApi';

interface BankAccount { id: string; bank_name: string; account_no: string; ledger_id: string }
interface ReconciliationListRow {
  id: string; statement_from: string; statement_to: string; opening_balance: number; closing_balance: number;
  status: string; bank_name: string; account_no: string; maker_name: string; checker_name: string | null;
  statement_lines: number; matched_lines: number;
}
interface StatementLine {
  id: string; sequence_no: number; txn_date: string; value_date: string | null; reference: string | null;
  description: string; amount: number; matched_payment_id: string | null; matched_voucher_no: string | null;
  matched_party: string | null;
}
interface Candidate {
  id: string; voucher_no: string; payment_date: string; kind: string; mode: string;
  instrument_no: string | null; narration: string; party_name: string; amount: number;
}
interface Detail {
  reconciliation: ReconciliationListRow & { created_by: string };
  lines: StatementLine[];
  candidates: Candidate[];
  summary: {
    statementLines: number; matchedLines: number; statementArithmeticDifference: number;
    bookClosing: number; unmatchedBook: number; unmatchedBookCount: number;
    adjustedStatement: number; difference: number;
  };
}
export interface ParsedStatementLine {
  txnDate: string; valueDate?: string | null; reference?: string | null; description?: string; amount: number;
}

const money = (n: number) => `₹${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
const today = () => new Date().toISOString().slice(0, 10);
const firstOfMonth = () => `${today().slice(0, 8)}01`;

function cells(line: string): string[] {
  const out: string[] = []; let value = ''; let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (char === '"' && quoted && line[i + 1] === '"') { value += '"'; i++; }
    else if (char === '"') quoted = !quoted;
    else if (char === ',' && !quoted) { out.push(value.trim()); value = ''; }
    else value += char;
  }
  out.push(value.trim());
  return out;
}

function date(value: string, row: number) {
  const clean = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(clean)) return clean;
  const indian = /^(\d{2})[/-](\d{2})[/-](\d{4})$/.exec(clean);
  if (indian) return `${indian[3]}-${indian[2]}-${indian[1]}`;
  throw new Error(`row ${row}: date must be YYYY-MM-DD or DD/MM/YYYY`);
}

function number(value: string, row: number) {
  const clean = value.replace(/[₹,\s]/g, '');
  const negative = /^\(.*\)$/.test(clean);
  const parsed = Number(clean.replace(/[()]/g, ''));
  if (!Number.isFinite(parsed)) throw new Error(`row ${row}: invalid amount "${value}"`);
  return negative ? -parsed : parsed;
}

/** Standard import format, independent of any one bank's proprietary CSV. */
export function parseStatementCsv(csv: string): ParsedStatementLine[] {
  const rows = csv.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (rows.length < 2) throw new Error('paste a header and at least one statement line');
  const header = cells(rows[0]!).map(h => h.toLowerCase().replaceAll(' ', '_'));
  const at = (name: string) => header.indexOf(name);
  const dateAt = at('date'); const amountAt = at('amount');
  const debitAt = at('debit'); const creditAt = at('credit');
  if (dateAt < 0 || (amountAt < 0 && debitAt < 0 && creditAt < 0)) {
    throw new Error('header needs date and either amount, or debit/credit columns');
  }
  return rows.slice(1).map((row, index) => {
    const c = cells(row); const rowNo = index + 2;
    const debit = debitAt >= 0 && c[debitAt] ? number(c[debitAt]!, rowNo) : 0;
    const credit = creditAt >= 0 && c[creditAt] ? number(c[creditAt]!, rowNo) : 0;
    const amount = amountAt >= 0 ? number(c[amountAt] ?? '', rowNo) : credit - debit;
    if (Math.abs(amount) < 0.005) throw new Error(`row ${rowNo}: amount cannot be zero`);
    return {
      txnDate: date(c[dateAt] ?? '', rowNo),
      valueDate: at('value_date') >= 0 && c[at('value_date')] ? date(c[at('value_date')]!, rowNo) : null,
      reference: at('reference') >= 0 ? c[at('reference')] || null : null,
      description: at('description') >= 0 ? c[at('description')] ?? '' : '',
      amount: Math.round(amount * 100) / 100
    };
  });
}

export const BankReconciliationView: React.FC<{ session: Session }> = ({ session }) => {
  const banks = useApi<BankAccount[]>('/bank-accounts');
  const reconciliations = useApi<ReconciliationListRow[]>('/bank-reconciliations');
  const [selected, setSelected] = useState('');
  const detail = useApi<Detail>(selected ? `/bank-reconciliations/${selected}` : null, [selected]);
  const [form, setForm] = useState({ bankAccountId: '', statementFrom: firstOfMonth(), statementTo: today(), openingBalance: 0, closingBalance: 0 });
  const [csv, setCsv] = useState('date,reference,description,debit,credit\n');
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (work: () => Promise<unknown>, success: string) => {
    setBusy(true); setNotice(null);
    try {
      await work(); setNotice({ kind: 'ok', text: success });
      reconciliations.reload(); detail.reload();
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof ApiError ? error.message : String(error) });
    } finally { setBusy(false); }
  };

  const parsed = useMemo(() => {
    try { return { rows: parseStatementCsv(csv), error: null as string | null }; }
    catch (error) { return { rows: [] as ParsedStatementLine[], error: error instanceof Error ? error.message : String(error) }; }
  }, [csv]);
  const importedClosing = form.openingBalance + parsed.rows.reduce((sum, line) => sum + line.amount, 0);

  const create = () => run(async () => {
    if (!form.bankAccountId) throw new Error('select a bank account');
    if (parsed.error) throw new Error(parsed.error);
    const out = await api.post<{ id: string }>('/bank-reconciliations', { ...form, lines: parsed.rows });
    setSelected(out.id);
  }, `${parsed.rows.length} bank line(s) imported into a draft reconciliation`);

  const choose = (line: StatementLine) => {
    const exact = (detail.data?.candidates ?? []).filter(c => Number(c.amount) === Number(line.amount));
    return exact;
  };
  const rec = detail.data?.reconciliation;
  const summary = detail.data?.summary;

  return <main className="flex flex-col h-full bg-[#ecf1f7] text-slate-800 text-xs" aria-labelledby="bank-rec-title">
    <ToolbarRibbon title="Bank Reconciliation" onPrint={() => window.print()} />
    <h1 id="bank-rec-title" className="sr-only">Bank statement reconciliation</h1>
    {notice && <div role={notice.kind === 'error' ? 'alert' : 'status'} className={`px-4 py-2 flex items-center gap-2 font-semibold ${notice.kind === 'error' ? 'bg-red-700 text-white' : 'bg-emerald-700 text-white'}`}>
      {notice.kind === 'error' ? <AlertTriangle className="w-4 h-4" /> : <CheckCircle2 className="w-4 h-4" />}{notice.text}
    </div>}
    <div className="flex-1 overflow-auto p-3 space-y-4 max-w-[1500px] w-full mx-auto">
      <section className="bg-white border border-[#b8c9dd] rounded p-4 space-y-3">
        <div><h2 className="text-sm font-bold text-blue-950">Import a complete bank statement</h2>
          <p className="text-slate-600 mt-1">Use the neutral CSV layout below. Debit is money out; credit is money in. The file must add from opening to closing exactly.</p></div>
        <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
          <label><span className="erp-label block">Bank account</span><select className="erp-input w-full" value={form.bankAccountId} onChange={e => setForm({ ...form, bankAccountId: e.target.value })}><option value="">— select —</option>{(banks.data ?? []).map(b => <option key={b.id} value={b.id}>{b.bank_name} · {b.account_no}</option>)}</select></label>
          <label><span className="erp-label block">Statement from</span><input className="erp-input w-full" type="date" value={form.statementFrom} onChange={e => setForm({ ...form, statementFrom: e.target.value })} /></label>
          <label><span className="erp-label block">Statement to</span><input className="erp-input w-full" type="date" value={form.statementTo} onChange={e => setForm({ ...form, statementTo: e.target.value })} /></label>
          <label><span className="erp-label block">Opening balance</span><input className="erp-input w-full text-right font-mono" type="number" step="0.01" value={form.openingBalance} onChange={e => setForm({ ...form, openingBalance: Number(e.target.value) })} /></label>
          <label><span className="erp-label block">Closing balance</span><input className="erp-input w-full text-right font-mono" type="number" step="0.01" value={form.closingBalance} onChange={e => setForm({ ...form, closingBalance: Number(e.target.value) })} /></label>
        </div>
        <label className="block"><span className="erp-label block">Statement CSV</span><textarea aria-describedby="csv-help" className="erp-input w-full min-h-36 font-mono" value={csv} onChange={e => setCsv(e.target.value)} /></label>
        <div id="csv-help" className={`rounded border px-3 py-2 flex flex-wrap gap-4 items-center ${parsed.error || Math.abs(importedClosing - form.closingBalance) > 0.005 ? 'bg-red-50 border-red-300 text-red-900' : 'bg-emerald-50 border-emerald-300 text-emerald-950'}`}>
          <span>{parsed.error ?? `${parsed.rows.length} line(s) · calculated closing ${money(importedClosing)}`}</span>
          {!parsed.error && Math.abs(importedClosing - form.closingBalance) > 0.005 && <strong>Out by {money(importedClosing - form.closingBalance)}</strong>}
          <button className="erp-btn erp-btn-primary ml-auto" disabled={busy || !!parsed.error || Math.abs(importedClosing - form.closingBalance) > 0.005} onClick={create}><Upload className="w-4 h-4" />Import statement</button>
        </div>
      </section>

      <section className="bg-white border border-[#b8c9dd] rounded overflow-hidden">
        <header className="p-3 border-b font-bold text-blue-950">Reconciliation history</header>
        <div className="overflow-x-auto"><table className="w-full min-w-[850px]"><thead className="bg-slate-100"><tr><th className="text-left p-2">Bank</th><th className="p-2">Period</th><th className="p-2 text-right">Closing</th><th className="p-2">Matched</th><th className="p-2">Maker</th><th className="p-2">Checker</th><th className="p-2">Status</th></tr></thead><tbody>
          {(reconciliations.data ?? []).map(r => <tr key={r.id} className={`border-t cursor-pointer ${selected === r.id ? 'bg-blue-50' : ''}`} onClick={() => setSelected(r.id)}><td className="p-2 font-semibold">{r.bank_name} · {r.account_no}</td><td className="p-2 text-center">{r.statement_from} – {r.statement_to}</td><td className="p-2 text-right font-mono">{money(r.closing_balance)}</td><td className="p-2 text-center">{r.matched_lines}/{r.statement_lines}</td><td className="p-2">{r.maker_name}</td><td className="p-2">{r.checker_name ?? '—'}</td><td className="p-2 text-center"><button className="erp-btn" onClick={e => { e.stopPropagation(); setSelected(r.id); }}>{r.status}</button></td></tr>)}
          {!reconciliations.loading && (reconciliations.data ?? []).length === 0 && <tr><td colSpan={7} className="p-6 text-center text-slate-600">No bank statement has been reconciled yet.</td></tr>}
        </tbody></table></div>
      </section>

      {detail.error && <div role="alert" className="bg-red-50 border border-red-300 text-red-900 p-3 rounded">{detail.error}</div>}
      {rec && summary && <section className="space-y-3">
        <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
          {[
            ['Bank closing', rec.closing_balance], ['Book closing', summary.bookClosing],
            [`Uncleared book items (${summary.unmatchedBookCount})`, summary.unmatchedBook],
            ['Adjusted statement', summary.adjustedStatement], ['Difference', summary.difference]
          ].map(([label, value]) => <div key={String(label)} className={`rounded border p-3 ${label === 'Difference' && Math.abs(Number(value)) > 0.005 ? 'bg-red-50 border-red-300' : 'bg-white border-slate-300'}`}><div className="text-slate-600">{label}</div><div className="font-bold font-mono text-base mt-1">{money(Number(value))}</div></div>)}
        </div>
        <div className="bg-white border border-[#b8c9dd] rounded overflow-x-auto"><table className="w-full min-w-[1050px]"><thead className="bg-slate-100"><tr><th className="p-2">Date</th><th className="text-left p-2">Reference / description</th><th className="text-right p-2">Statement</th><th className="text-left p-2">Book candidate</th><th className="p-2">Action</th></tr></thead><tbody>
          {(detail.data?.lines ?? []).map(line => {
            const exact = choose(line); const selection = picked[line.id] ?? exact[0]?.id ?? '';
            return <tr key={line.id} className="border-t"><td className="p-2 text-center">{line.txn_date}</td><td className="p-2"><div className="font-mono">{line.reference ?? '—'}</div><div className="text-slate-600">{line.description}</div></td><td className={`p-2 text-right font-mono font-bold ${Number(line.amount) < 0 ? 'text-red-800' : 'text-emerald-800'}`}>{money(line.amount)}</td><td className="p-2">{line.matched_payment_id ? <span className="font-semibold">{line.matched_voucher_no} · {line.matched_party}</span> : <select aria-label={`Book candidate for statement line ${line.sequence_no}`} className="erp-input w-full" value={selection} onChange={e => setPicked({ ...picked, [line.id]: e.target.value })}><option value="">— no exact amount candidate —</option>{exact.map(c => <option key={c.id} value={c.id}>{c.payment_date} · {c.voucher_no} · {c.party_name} · {c.instrument_no ?? c.mode}</option>)}</select>}</td><td className="p-2 text-center">{rec.status === 'draft' && (line.matched_payment_id ? <button className="erp-btn" disabled={busy} onClick={() => run(() => api.post(`/bank-reconciliations/${rec.id}/lines/${line.id}/unmatch`, {}), 'Match removed')}>Unmatch</button> : <button className="erp-btn erp-btn-primary" disabled={busy || !selection} onClick={() => run(() => api.post(`/bank-reconciliations/${rec.id}/lines/${line.id}/match`, { paymentId: selection }), 'Statement line matched')}><Link2 className="w-4 h-4" />Match</button>)}</td></tr>;
          })}
        </tbody></table></div>
        <div className={`rounded border p-3 flex flex-wrap items-center gap-3 ${summary.matchedLines === summary.statementLines && Math.abs(summary.difference) < 0.005 ? 'bg-emerald-50 border-emerald-300' : 'bg-amber-50 border-amber-300'}`}>
          <strong>{summary.matchedLines}/{summary.statementLines} statement lines matched · difference {money(summary.difference)}</strong>
          {rec.status === 'draft' && <><button className="erp-btn ml-auto" disabled={busy} onClick={() => run(() => api.post(`/bank-reconciliations/${rec.id}/cancel`, {}), 'Draft reconciliation cancelled')}>Cancel draft</button>{session.role === 'owner' && <button className="erp-btn erp-btn-primary" disabled={busy || summary.matchedLines !== summary.statementLines || Math.abs(summary.difference) > 0.005 || rec.created_by === session.userId} onClick={() => run(() => api.post(`/bank-reconciliations/${rec.id}/complete`, {}), 'Reconciliation checked, completed, and frozen')}><LockKeyhole className="w-4 h-4" />Owner complete</button>}</>}
          {rec.status === 'completed' && <span className="ml-auto font-bold text-emerald-900">Frozen after maker-checker completion</span>}
        </div>
      </section>}
    </div>
  </main>;
};
