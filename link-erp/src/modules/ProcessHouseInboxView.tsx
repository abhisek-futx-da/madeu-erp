import React, { useState } from 'react';
import { ToolbarRibbon } from '../components/ToolbarRibbon';
import { useApi } from '../lib/useApi';
import { api, ApiError, type Session } from '../lib/api';
import { AlertTriangle, CheckCircle2, Inbox, UserPlus } from 'lucide-react';

/**
 * What the process houses have told us, and giving them the login to tell us.
 *
 * The point of the portal is that the shrinkage argument now has a written
 * record on both sides. This screen is the mill's half: what was said, when,
 * and what we answered — with the answer recorded as an event, so neither side
 * can later claim it went differently.
 */

const KIND_LABEL: Record<string, string> = {
  custody_ack: 'Goods received',
  shortage: 'Short delivery',
  rejection: 'Damaged or off-shade',
  expected_return: 'Expected return date',
  return_dispatch: 'Sent back to us'
};

const STATE_CHIP: Record<string, string> = {
  submitted: 'bg-amber-100 text-amber-900 border-amber-400',
  accepted: 'bg-emerald-100 text-emerald-900 border-emerald-400',
  rejected: 'bg-red-100 text-red-900 border-red-400'
};

interface Row {
  declaration_id: string; kind: string; party: string; their_ref: string;
  vehicle_no: string | null; expected_on: string | null; note: string;
  declared_at: string; declared_by: string | null; entry_no: string | null;
  challan_no: string | null; state: string; waiting_days: number; pieces: number;
}

interface Detail {
  declaration: Row;
  lines: { barcode: string; qty: number | null; reason: string; quality: string | null; lot_no: string | null }[];
  history: { state: string; note: string; created_at: string; actor: string | null }[];
}

interface PortalUser {
  user_id: string; email: string; full_name: string; party: string;
  party_id: string; is_active: boolean; account_active: boolean;
}

export const ProcessHouseInboxView: React.FC<{ session: Session }> = ({ session }) => {
  const [state, setState] = useState<'submitted' | 'all'>('submitted');
  const [open, setOpen] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const inbox = useApi<Row[]>(`/party-declarations?state=${state}`, [state]);
  const detail = useApi<Detail>(open ? `/party-declarations/${open}` : null, [open]);
  const isOwner = session.role === 'owner';

  const answer = async (id: string, verdict: 'accept' | 'reject') => {
    const note = window.prompt(
      verdict === 'accept' ? 'Note for accepting (optional)' : 'Why is this not accepted?'
    );
    if (verdict === 'reject' && !note?.trim()) return;
    setError(null);
    try {
      const out = await api.post<{ party: string; state: string }>(
        `/party-declarations/${id}/${verdict}`, { note: note ?? '' }
      );
      setNotice(`${out.party}: ${out.state}`);
      inbox.reload();
      if (open === id) detail.reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  };

  const rows = inbox.data ?? [];

  return (
    <div className="flex flex-col h-full bg-[#ecf1f7] text-slate-800 text-xs">
      <ToolbarRibbon
        title="Process Houses"
        actions={[{ key: 'reset', onRun: () => { inbox.reload(); setOpen(null); } }]}
      />

      {(error || notice) && (
        <div className={`px-4 py-1.5 flex items-center gap-2 font-semibold ${
          error ? 'bg-red-600 text-white' : 'bg-emerald-600 text-white'
        }`}>
          {error ? <AlertTriangle className="w-4 h-4 shrink-0" /> : <CheckCircle2 className="w-4 h-4 shrink-0" />}
          <span>{error ?? notice}</span>
        </div>
      )}

      <div className="p-3 flex-1 overflow-y-auto max-w-6xl mx-auto w-full space-y-3">
        <div className="flex items-center gap-2">
          <Inbox className="w-4 h-4 text-blue-700" />
          <span className="font-bold text-blue-900">
            {state === 'submitted' ? 'Waiting on us' : 'Everything they have told us'}
          </span>
          <button onClick={() => setState(s => (s === 'submitted' ? 'all' : 'submitted'))}
                  className="erp-btn py-0.5 ml-auto">
            {state === 'submitted' ? 'Show all' : 'Show only waiting'}
          </button>
        </div>

        <div className="bg-white rounded border border-[#b8c9dd] overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-slate-100 border-b border-slate-300 text-left">
                <tr>
                  <th className="px-2 py-1.5 font-bold">Process house</th>
                  <th className="px-2 py-1.5 font-bold">Said</th>
                  <th className="px-2 py-1.5 font-bold">Challan</th>
                  <th className="px-2 py-1.5 font-bold text-right">Thaans</th>
                  <th className="px-2 py-1.5 font-bold">When</th>
                  <th className="px-2 py-1.5 font-bold">State</th>
                  <th className="px-2 py-1.5"></th>
                </tr>
              </thead>
              <tbody>
                {inbox.loading && (
                  <tr><td colSpan={7} className="px-2 py-6 text-center text-slate-400">Loading…</td></tr>
                )}
                {!inbox.loading && rows.length === 0 && (
                  <tr><td colSpan={7} className="px-2 py-6 text-center text-slate-400">
                    {state === 'submitted'
                      ? 'Nothing is waiting on us.'
                      : 'No process house has told us anything yet.'}
                  </td></tr>
                )}
                {rows.map(r => (
                  <tr key={r.declaration_id}
                      className={`border-b border-slate-100 cursor-pointer hover:bg-blue-50 ${
                        open === r.declaration_id ? 'bg-blue-50' : ''
                      }`}
                      onClick={() => setOpen(o => (o === r.declaration_id ? null : r.declaration_id))}>
                    <td className="px-2 py-1 font-semibold">{r.party}</td>
                    <td className="px-2 py-1">{KIND_LABEL[r.kind] ?? r.kind}</td>
                    <td className="px-2 py-1 font-mono">{r.challan_no ?? '—'}</td>
                    <td className="px-2 py-1 text-right font-mono">{r.pieces || '—'}</td>
                    <td className="px-2 py-1">
                      {r.waiting_days > 0 ? `${r.waiting_days}d ago` : 'today'}
                    </td>
                    <td className="px-2 py-1">
                      <span className={`px-1.5 py-0.5 rounded border font-bold ${
                        STATE_CHIP[r.state] ?? STATE_CHIP.submitted
                      }`}>{r.state}</span>
                    </td>
                    <td className="px-2 py-1 text-right whitespace-nowrap">
                      {r.state === 'submitted' && (
                        <>
                          <button className="erp-btn py-0.5"
                                  onClick={e => { e.stopPropagation(); void answer(r.declaration_id, 'accept'); }}>
                            Accept
                          </button>
                          <button className="erp-btn py-0.5 ml-1"
                                  onClick={e => { e.stopPropagation(); void answer(r.declaration_id, 'reject'); }}>
                            Send back
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {open && detail.data && (
          <div className="bg-white rounded border border-[#b8c9dd] p-3 space-y-2">
            <p className="font-bold text-blue-900">
              {KIND_LABEL[detail.data.declaration.kind]} — {detail.data.declaration.party}
            </p>
            {detail.data.declaration.note && <p>{detail.data.declaration.note}</p>}
            {detail.data.declaration.their_ref && (
              <p className="text-slate-600">
                Their challan {detail.data.declaration.their_ref}
                {detail.data.declaration.vehicle_no ? ` · vehicle ${detail.data.declaration.vehicle_no}` : ''}
              </p>
            )}
            {detail.data.declaration.expected_on && (
              <p className="text-slate-600">Expected back {detail.data.declaration.expected_on}</p>
            )}

            {detail.data.lines.length > 0 && (
              <table className="w-full">
                <thead className="border-b border-slate-200 text-left text-slate-600">
                  <tr>
                    <th className="px-2 py-1">Barcode</th><th className="px-2 py-1">Quality</th>
                    <th className="px-2 py-1 text-right">They say</th><th className="px-2 py-1">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.data.lines.map(l => (
                    <tr key={l.barcode} className="border-b border-slate-100">
                      <td className="px-2 py-1 font-mono text-blue-800">{l.barcode}</td>
                      <td className="px-2 py-1">{l.quality ?? '—'}</td>
                      <td className="px-2 py-1 text-right font-mono">
                        {l.qty === null ? '—' : Number(l.qty).toFixed(2)}
                      </td>
                      <td className="px-2 py-1 text-slate-600">{l.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {detail.data.history.length > 0 && (
              <div className="border-t border-slate-200 pt-2">
                {detail.data.history.map((h, i) => (
                  <p key={i} className="text-slate-600">
                    {h.state} by {h.actor ?? 'someone'} — {h.note || 'no note'}
                  </p>
                ))}
              </div>
            )}

            <p className="text-slate-500">
              Accepting records agreement. It does not move stock: a return still comes in
              through Receive From Dyeing, and a rejection through the return document.
            </p>
          </div>
        )}

        {isOwner && <PortalUsers onNotice={setNotice} onError={setError} />}
      </div>
    </div>
  );
};

// ------------------------------------------------------------------ logins --

const PortalUsers: React.FC<{
  onNotice: (m: string) => void; onError: (m: string) => void;
}> = ({ onNotice, onError }) => {
  const users = useApi<PortalUser[]>('/portal-users');
  const parties = useApi<{ id: string; name: string; control_account_id: string }[]>('/ledgers');
  const controls = useApi<{ id: string; nature: string }[]>('/control-accounts');
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [partyId, setPartyId] = useState('');
  const [password, setPassword] = useState('');

  const processControls = new Set(
    (controls.data ?? []).filter(c => c.nature === 'sundry_creditor_process').map(c => c.id)
  );
  const houses = (parties.data ?? []).filter(p => processControls.has(p.control_account_id));

  const create = async () => {
    try {
      const out = await api.post<{ party: string }>('/portal-users', {
        email, fullName, partyId, password
      });
      onNotice(`${out.party} can now sign in at the portal`);
      setEmail(''); setFullName(''); setPassword('');
      users.reload();
    } catch (e) {
      onError(e instanceof ApiError ? e.message : String(e));
    }
  };

  const disable = async (id: string) => {
    try {
      await api.post(`/portal-users/${id}/disable`, {});
      onNotice('that login can no longer sign in');
      users.reload();
    } catch (e) {
      onError(e instanceof ApiError ? e.message : String(e));
    }
  };

  return (
    <div className="bg-white rounded border border-[#b8c9dd] p-3 space-y-3">
      <div className="font-bold text-blue-900 flex items-center gap-1.5">
        <UserPlus className="w-4 h-4" /> Process-house logins
      </div>

      <div className="grid grid-cols-12 gap-2.5">
        <div className="col-span-12 md:col-span-3">
          <label className="erp-label block" htmlFor="ph-party">Process house</label>
          <select id="ph-party" value={partyId} onChange={e => setPartyId(e.target.value)}
                  className="erp-input w-full">
            <option value="">— select —</option>
            {houses.map(h => <option key={h.id} value={h.id}>{h.name}</option>)}
          </select>
        </div>
        <div className="col-span-6 md:col-span-3">
          <label className="erp-label block" htmlFor="ph-email">Their email</label>
          <input id="ph-email" type="email" value={email} onChange={e => setEmail(e.target.value)}
                 className="erp-input w-full" />
        </div>
        <div className="col-span-6 md:col-span-3">
          <label className="erp-label block" htmlFor="ph-name">Contact name</label>
          <input id="ph-name" value={fullName} onChange={e => setFullName(e.target.value)}
                 className="erp-input w-full" />
        </div>
        <div className="col-span-8 md:col-span-2">
          <label className="erp-label block" htmlFor="ph-pass">First password</label>
          <input id="ph-pass" value={password} onChange={e => setPassword(e.target.value)}
                 placeholder="at least 12 characters" className="erp-input w-full font-mono" />
        </div>
        <div className="col-span-4 md:col-span-1 flex items-end">
          <button onClick={create} className="erp-btn erp-btn-primary w-full"
                  disabled={!partyId || !email || !fullName || password.length < 12}>
            Create
          </button>
        </div>
      </div>

      <p className="text-slate-500">
        They sign in at <span className="font-mono">/#portal</span> — a separate application that
        can see only their own goods and cannot move stock or see any money.
      </p>

      <table className="w-full">
        <tbody>
          {(users.data ?? []).length === 0 && (
            <tr><td className="px-2 py-3 text-slate-400">No process house has a login yet.</td></tr>
          )}
          {(users.data ?? []).map(u => (
            <tr key={u.user_id} className="border-b border-slate-100">
              <td className="px-2 py-1 font-semibold">{u.party}</td>
              <td className="px-2 py-1 font-mono">{u.email}</td>
              <td className="px-2 py-1">{u.full_name}</td>
              <td className="px-2 py-1">
                {u.is_active
                  ? <span className="text-emerald-700 font-bold">active</span>
                  : <span className="text-slate-400">disabled</span>}
              </td>
              <td className="px-2 py-1 text-right">
                {u.is_active && (
                  <button onClick={() => disable(u.user_id)} className="erp-btn py-0.5">Disable</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
