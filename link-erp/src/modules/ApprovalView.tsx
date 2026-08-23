import { useState } from 'react';
import { ShieldCheck, X, Check, Ban, Clock, AlertTriangle } from 'lucide-react';
import { ToolbarRibbon } from '../components/ToolbarRibbon';
import { useApi } from '../lib/useApi';
import { api } from '../lib/api';
import type { Session } from '../lib/api';

/**
 * The approval queue. A document over the mill's limit is raised but not
 * posted; nothing reaches the ledger until someone other than the person who
 * raised it agrees. That second-pair-of-eyes rule is enforced server-side —
 * this screen is where it gets exercised.
 */

interface Pending {
  doc_type: string; doc_id: string; doc_no: string; doc_date: string;
  amount: number; party: string; raised_by: string; raised_by_name: string | null;
  created_at: string; approver_role: string | null; min_amount: number | null;
  waiting_days: number;
}
interface HistoryRow {
  doc_type: string; doc_no?: string; action: string; amount: number;
  note: string; created_at: string; actor: string | null; actor_role: string | null;
}
interface Rule {
  doc_type: string; min_amount: number; approver_role: string; is_active: boolean;
}

const money = (n: number) =>
  `₹${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

const LABEL: Record<string, string> = {
  sales_invoice: 'Tax invoice',
  purchase_invoice: 'Purchase bill',
  payment: 'Payment',
  stock_count: 'Physical stock count',
  grey_return: 'Grey return to weaver',
  dyeing_return: 'Return to process house',
  dyeing_reprocess_receipt: 'Reprocess job charge',
  customer_return: 'Customer return',
  write_off: 'Write-off / damage'
};

const ACTION_STYLE: Record<string, string> = {
  submitted: 'bg-amber-50 border-amber-300 text-amber-900',
  approved: 'bg-emerald-50 border-emerald-300 text-emerald-800',
  rejected: 'bg-red-50 border-red-300 text-red-800'
};

export const ApprovalView: React.FC<{ session: Session }> = ({ session }) => {
  const pending = useApi<Pending[]>('/approvals/pending');
  const history = useApi<HistoryRow[]>('/approvals/history?limit=50');
  const rules = useApi<Rule[]>('/approval-rules');
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = () => { pending.reload(); history.reload(); };

  const act = async (row: Pending, action: 'approve' | 'reject') => {
    const reason = action === 'reject'
      ? prompt(`Why is ${row.doc_no} being sent back?`)
      : prompt(`Note for approving ${row.doc_no} (optional)`, '') ?? '';
    if (action === 'reject' && !reason) return;

    setBusy(row.doc_id);
    try {
      const out = await api.post<any>(
        `/approvals/${row.doc_type}/${row.doc_id}/${action}`,
        action === 'reject' ? { reason } : { note: reason }
      );
      // A stock count that found nothing wrong has no entry to make; saying
      // "posted as null" would read as a failure.
      setNotice(action === 'approve'
        ? `${out.docNo} approved${out.voucherNo ? ` — posted as ${out.voucherNo}` : ' — nothing to post'}`
        : `${out.docNo} sent back: ${out.reason}`);
      refresh();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const rows = pending.data ?? [];
  const total = rows.reduce((n, r) => n + Number(r.amount), 0);

  return (
    <div className="flex flex-col h-full bg-[#ecf1f7] text-slate-800 text-xs">
      <ToolbarRibbon
        title="Approvals"
        actions={[
          { key: 'reset', onRun: refresh, hint: 'Refresh (Esc)' },
          { key: 'print', onRun: () => window.print() }
        ]}
      />

      {notice && (
        <div className={`px-4 py-1.5 flex items-center gap-2 font-semibold ${
          /approved|sent back/.test(notice) ? 'bg-emerald-600 text-white' : 'bg-red-600 text-white'
        }`}>
          {/approved|sent back/.test(notice)
            ? <Check className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />}
          <span>{notice}</span>
          <button onClick={() => setNotice(null)} className="ml-auto"><X className="w-4 h-4" /></button>
        </div>
      )}

      <div className="flex-1 overflow-auto p-3 space-y-3 print-area">
        <section className="bg-white rounded border border-[#b8c9dd]">
          <header className="px-3 py-2 border-b border-slate-200 flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-blue-700" />
            <span className="font-bold text-blue-900">
              Waiting for a second signature ({rows.length})
            </span>
            {rows.length > 0 && (
              <span className="ml-auto font-mono font-bold">{money(total)} held</span>
            )}
          </header>

          <table className="w-full">
            <thead className="bg-slate-100 border-b border-slate-300 text-left">
              <tr>
                <th className="px-2 py-1.5 font-bold">Document</th>
                <th className="px-2 py-1.5 font-bold">Number</th>
                <th className="px-2 py-1.5 font-bold">Date</th>
                <th className="px-2 py-1.5 font-bold">Party</th>
                <th className="px-2 py-1.5 font-bold text-right">Amount</th>
                <th className="px-2 py-1.5 font-bold">Raised by</th>
                <th className="px-2 py-1.5 font-bold">Needs</th>
                <th className="px-2 py-1.5 font-bold text-right">Waiting</th>
                <th className="px-2 py-1.5"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                // The maker can never be the checker; say so before they click.
                const isMine = r.raised_by === session.userId;
                const wrongRole = r.approver_role
                  && session.role !== r.approver_role && session.role !== 'owner';
                const blocked = isMine ? 'you raised this one' : wrongRole
                  ? `needs the ${r.approver_role} role` : null;

                return (
                  <tr key={r.doc_id} className="border-b border-slate-100 hover:bg-blue-50/40">
                    <td className="px-2 py-1">{LABEL[r.doc_type] ?? r.doc_type}</td>
                    <td className="px-2 py-1 font-mono text-blue-800">{r.doc_no}</td>
                    <td className="px-2 py-1">{r.doc_date}</td>
                    <td className="px-2 py-1">{r.party}</td>
                    <td className="px-2 py-1 text-right font-mono font-bold">{money(r.amount)}</td>
                    <td className="px-2 py-1">{r.raised_by_name ?? '—'}</td>
                    <td className="px-2 py-1">
                      <span className="px-1.5 py-0.5 rounded border bg-slate-50 border-slate-300">
                        {r.approver_role ?? 'owner'}
                      </span>
                    </td>
                    <td className={`px-2 py-1 text-right font-mono ${
                      r.waiting_days > 2 ? 'text-red-700 font-bold' : ''
                    }`}>
                      {r.waiting_days}d
                    </td>
                    <td className="px-2 py-1 text-right whitespace-nowrap">
                      <button
                        onClick={() => act(r, 'approve')}
                        disabled={busy === r.doc_id || Boolean(blocked)}
                        title={blocked ?? 'Approve and post'}
                        className="erp-btn erp-btn-primary disabled:opacity-40 disabled:cursor-not-allowed">
                        <Check className="w-3.5 h-3.5" /> Approve
                      </button>
                      <button
                        onClick={() => act(r, 'reject')}
                        disabled={busy === r.doc_id || Boolean(wrongRole)}
                        title={wrongRole ? `needs the ${r.approver_role} role` : 'Send back'}
                        className="erp-btn disabled:opacity-40 disabled:cursor-not-allowed">
                        <Ban className="w-3.5 h-3.5 text-red-600" />
                      </button>
                    </td>
                  </tr>
                );
              })}
              {!pending.loading && rows.length === 0 && (
                <tr><td colSpan={9} className="px-2 py-6 text-center text-slate-400">
                  Nothing is waiting — every document is posted
                </td></tr>
              )}
            </tbody>
          </table>
        </section>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <section className="bg-white rounded border border-[#b8c9dd]">
            <header className="px-3 py-2 border-b border-slate-200 font-bold text-blue-900">
              Limits in force
            </header>
            <table className="w-full">
              <thead className="bg-slate-100 border-b border-slate-300 text-left">
                <tr>
                  <th className="px-2 py-1.5 font-bold">Document</th>
                  <th className="px-2 py-1.5 font-bold text-right">Above</th>
                  <th className="px-2 py-1.5 font-bold">Approved by</th>
                </tr>
              </thead>
              <tbody>
                {(rules.data ?? []).map(r => (
                  <tr key={r.doc_type} className="border-b border-slate-100">
                    <td className="px-2 py-1">{LABEL[r.doc_type] ?? r.doc_type}</td>
                    <td className="px-2 py-1 text-right font-mono">{money(r.min_amount)}</td>
                    <td className="px-2 py-1">
                      {r.is_active
                        ? r.approver_role
                        : <span className="text-slate-400">off</span>}
                    </td>
                  </tr>
                ))}
                {(rules.data ?? []).length === 0 && (
                  <tr><td colSpan={3} className="px-2 py-4 text-center text-slate-400">
                    No limits set — everything posts straight away
                  </td></tr>
                )}
              </tbody>
            </table>
            {session.role === 'owner' && (
              <p className="px-3 py-2 text-slate-500 border-t border-slate-100">
                Only the owner can change these.
              </p>
            )}
          </section>

          <section className="bg-white rounded border border-[#b8c9dd]">
            <header className="px-3 py-2 border-b border-slate-200 font-bold text-blue-900 flex items-center gap-1">
              <Clock className="w-3.5 h-3.5" /> Recent decisions
            </header>
            <table className="w-full">
              <tbody>
                {(history.data ?? []).slice(0, 15).map((h, i) => (
                  <tr key={i} className="border-b border-slate-100">
                    <td className="px-2 py-1">
                      <span className={`px-1.5 py-0.5 rounded border font-semibold ${ACTION_STYLE[h.action]}`}>
                        {h.action}
                      </span>
                    </td>
                    <td className="px-2 py-1">{LABEL[h.doc_type] ?? h.doc_type}</td>
                    <td className="px-2 py-1 text-right font-mono">{money(h.amount)}</td>
                    <td className="px-2 py-1">
                      {h.actor ?? '—'}
                      {h.actor_role && <span className="text-slate-400 ml-1">{h.actor_role}</span>}
                    </td>
                    <td className="px-2 py-1 text-slate-500">{h.note || ''}</td>
                    <td className="px-2 py-1 text-slate-400 whitespace-nowrap">
                      {new Date(h.created_at).toLocaleDateString('en-IN')}
                    </td>
                  </tr>
                ))}
                {(history.data ?? []).length === 0 && (
                  <tr><td colSpan={6} className="px-2 py-4 text-center text-slate-400">
                    Nothing has been approved or sent back yet
                  </td></tr>
                )}
              </tbody>
            </table>
          </section>
        </div>
      </div>
    </div>
  );
};
