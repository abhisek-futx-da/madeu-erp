import React, { useMemo, useState } from 'react';
import { ToolbarRibbon } from '../components/ToolbarRibbon';
import { useApi, useSubmit } from '../lib/useApi';
import { api, ApiError, type QualityRow } from '../lib/api';
import {
  ClipboardCheck, ScanLine, AlertTriangle, CheckCircle2, Trash2, ArrowLeft, Printer
} from 'lucide-react';

/**
 * Physical stock count.
 *
 * The screen exists to make one thing impossible: correcting stock without
 * saying what changed and why. Every difference the floor found has to be
 * answered with an outcome and a reason before the sheet can be submitted, and
 * a second person releases it. There is no button anywhere here that edits a
 * quantity directly, because there is no such endpoint.
 */

const money = (n: unknown) => {
  const v = Number(n ?? 0);
  return `${v < 0 ? '−' : ''}₹${Math.abs(v).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
};
const today = () => new Date().toISOString().slice(0, 10);

type Kind = 'missing' | 'extra' | 'short' | 'excess' | 'wrong_rack' | 'duplicate_scan';
type Outcome =
  | 'write_off' | 'adjust_qty' | 'relocate' | 'accept_system' | 'needs_inward' | 'investigate';

const KIND_LABEL: Record<Kind, string> = {
  missing: 'Not on the rack',
  extra: 'Found, not expected',
  short: 'Shorter than the books',
  excess: 'Longer than the books',
  wrong_rack: 'Wrong shelf',
  duplicate_scan: 'Scanned twice'
};

/** Mirrors the server's list exactly; it refuses anything else anyway. */
const LEGAL: Record<Kind, Outcome[]> = {
  missing: ['write_off', 'accept_system', 'investigate'],
  extra: ['relocate', 'needs_inward', 'accept_system', 'investigate'],
  short: ['adjust_qty', 'accept_system', 'investigate'],
  excess: ['adjust_qty', 'accept_system', 'investigate'],
  wrong_rack: ['relocate', 'accept_system', 'investigate'],
  duplicate_scan: ['accept_system', 'investigate']
};

const OUTCOME_LABEL: Record<Outcome, string> = {
  write_off: 'Write it off',
  adjust_qty: 'Take the floor’s figure',
  relocate: 'Record the new shelf',
  accept_system: 'The count was wrong',
  needs_inward: 'Book it in separately',
  investigate: 'Leave it for someone to look at'
};

interface Exception {
  barcode: string; piece_id: string | null; kind: Kind;
  system_qty: number | null; counted_qty: number | null;
  system_rack: string | null; counted_rack: string | null; value: number;
}
interface SheetRow {
  barcode: string; quality: string; rack_code: string | null;
  qty: number; status: string; lot_no: string; scanned: boolean;
}
interface ScanRow { id: number; barcode: string; rack_code: string | null; qty: number | null }
interface VarianceRow {
  barcode: string; kind: string; outcome: string; system_qty: number | null;
  counted_qty: number | null; system_rack: string | null; counted_rack: string | null;
  value: number; reason: string; quality: string | null;
}
interface CountSummary {
  count_id: string; count_no: string; count_date: string; status: string;
  rack_code: string | null; quality: string | null; lot_no: string | null; reason: string;
  pieces_expected: number; pieces_counted: number; variances: number;
  loss_value: number; gain_value: number; net_value: number; counted_by: string | null;
}
interface Detail {
  count: CountSummary; sheet: SheetRow[]; exceptions: Exception[];
  scans: ScanRow[]; variances: VarianceRow[];
}

export const StockCountView: React.FC = () => {
  const [openId, setOpenId] = useState<string | null>(null);
  return openId
    ? <CountSheet countId={openId} onClose={() => setOpenId(null)} />
    : <CountList onOpen={setOpenId} />;
};

// -------------------------------------------------------------------- list --

const CountList: React.FC<{ onOpen: (id: string) => void }> = ({ onOpen }) => {
  const [countDate, setCountDate] = useState(today());
  const [rackCode, setRackCode] = useState('');
  const [qualityId, setQualityId] = useState('');
  const [lotNo, setLotNo] = useState('');
  const [reason, setReason] = useState('');

  const list = useApi<{ rows: CountSummary[]; total: number }>('/stock-counts?limit=100');
  const racks = useApi<{ code: string; name: string }[]>('/racks');
  const qualities = useApi<QualityRow[]>('/qualities');
  const { submit, busy, error } = useSubmit<unknown, { id: string }>('/stock-counts');

  const start = async () => {
    const out = await submit({
      countDate, reason,
      rackCode: rackCode || null,
      qualityId: qualityId || null,
      lotNo: lotNo || null
    });
    if (out?.id) onOpen(out.id);
  };

  return (
    <div className="flex flex-col h-full bg-[#ecf1f7] text-slate-800 text-xs">
      <ToolbarRibbon
        title="Physical Stock Count"
        actions={[{ key: 'save', onRun: start, disabled: busy, hint: 'open a new count sheet' },
                  { key: 'reset', onRun: () => list.reload() }]}
      />
      {error && (
        <div className="px-4 py-1.5 bg-red-600 text-white font-semibold flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0" /><span>{error}</span>
        </div>
      )}

      <div className="p-3 flex-1 overflow-y-auto max-w-6xl mx-auto w-full space-y-3">
        <div className="bg-white rounded border border-[#b8c9dd] p-3">
          <div className="font-bold text-blue-900 mb-2 flex items-center gap-1.5">
            <ClipboardCheck className="w-4 h-4" /> Open a new count
          </div>
          <div className="grid grid-cols-12 gap-2.5">
            <div className="col-span-6 md:col-span-2">
              <label className="erp-label block" htmlFor="sc-date">Date</label>
              <input id="sc-date" type="date" value={countDate} onChange={e => setCountDate(e.target.value)}
                     className="erp-input w-full" />
            </div>
            <div className="col-span-6 md:col-span-2">
              <label className="erp-label block" htmlFor="sc-rack">Rack</label>
              <select id="sc-rack" value={rackCode} onChange={e => setRackCode(e.target.value)}
                      className="erp-input w-full">
                <option value="">every rack</option>
                {(racks.data ?? []).map(r => (
                  <option key={r.code} value={r.code}>{r.code} — {r.name}</option>
                ))}
              </select>
            </div>
            <div className="col-span-6 md:col-span-3">
              <label className="erp-label block" htmlFor="sc-quality">Quality</label>
              <select id="sc-quality" value={qualityId} onChange={e => setQualityId(e.target.value)}
                      className="erp-input w-full">
                <option value="">every quality</option>
                {(qualities.data ?? []).map(q => (
                  <option key={q.id} value={q.id}>{q.name}</option>
                ))}
              </select>
            </div>
            <div className="col-span-6 md:col-span-2">
              <label className="erp-label block" htmlFor="sc-lot">Lot</label>
              <input id="sc-lot" value={lotNo} onChange={e => setLotNo(e.target.value)}
                     placeholder="every lot" className="erp-input w-full font-mono" />
            </div>
            <div className="col-span-12 md:col-span-3">
              <label className="erp-label block" htmlFor="sc-reason">Why</label>
              <input id="sc-reason" value={reason} onChange={e => setReason(e.target.value)} maxLength={200}
                     placeholder="e.g. month end" className="erp-input w-full" />
            </div>
          </div>
          <p className="text-slate-500 mt-2">
            Goods lying at a process house are not counted here — they are not in our hands.
            The sheet freezes the system’s answer the moment it opens, so a dispatch made while
            you walk the aisle does not read as missing.
          </p>
        </div>

        <div className="bg-white rounded border border-[#b8c9dd] overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-slate-100 border-b border-slate-300 text-left">
                <tr>
                  <th className="px-2 py-1.5 font-bold">Count</th>
                  <th className="px-2 py-1.5 font-bold">Date</th>
                  <th className="px-2 py-1.5 font-bold">Scope</th>
                  <th className="px-2 py-1.5 font-bold text-right">Expected</th>
                  <th className="px-2 py-1.5 font-bold text-right">Counted</th>
                  <th className="px-2 py-1.5 font-bold text-right">Differences</th>
                  <th className="px-2 py-1.5 font-bold text-right">Net</th>
                  <th className="px-2 py-1.5 font-bold">State</th>
                </tr>
              </thead>
              <tbody>
                {list.loading && (
                  <tr><td colSpan={8} className="px-2 py-6 text-center text-slate-400">Loading…</td></tr>
                )}
                {!list.loading && (list.data?.rows ?? []).length === 0 && (
                  <tr><td colSpan={8} className="px-2 py-6 text-center text-slate-400">
                    No stock has been counted yet.
                  </td></tr>
                )}
                {(list.data?.rows ?? []).map(c => (
                  <tr key={c.count_id} onClick={() => onOpen(c.count_id)}
                      className="border-b border-slate-100 cursor-pointer hover:bg-blue-50">
                    <td className="px-2 py-1 font-mono text-blue-800">{c.count_no}</td>
                    <td className="px-2 py-1">{c.count_date}</td>
                    <td className="px-2 py-1">
                      {[c.rack_code && `Rack ${c.rack_code}`, c.quality, c.lot_no && `Lot ${c.lot_no}`]
                        .filter(Boolean).join(' · ') || 'everything'}
                    </td>
                    <td className="px-2 py-1 text-right font-mono">{c.pieces_expected}</td>
                    <td className="px-2 py-1 text-right font-mono">{c.pieces_counted}</td>
                    <td className="px-2 py-1 text-right font-mono">{c.variances}</td>
                    <td className={`px-2 py-1 text-right font-mono ${
                      Number(c.net_value) < 0 ? 'text-red-700' : ''
                    }`}>{money(c.net_value)}</td>
                    <td className="px-2 py-1"><StatusChip status={c.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        {list.error && <p className="text-red-700 px-1">{list.error}</p>}
      </div>
    </div>
  );
};

// ------------------------------------------------------------------- sheet --

const CountSheet: React.FC<{ countId: string; onClose: () => void }> = ({ countId, onClose }) => {
  const detail = useApi<Detail>(`/stock-counts/${countId}`);
  const [scan, setScan] = useState('');
  const [rack, setRack] = useState('');
  const [qty, setQty] = useState('');
  const [answers, setAnswers] = useState<Record<string, { outcome: Outcome; reason: string }>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastScan, setLastScan] = useState<{ barcode: string; ok: boolean } | null>(null);

  const d = detail.data;
  const open = d?.count.status === 'draft';
  const held = d?.count.status === 'pending_approval';
  const key = (e: { barcode: string; kind: string }) => `${e.barcode}|${e.kind}`;

  const counted = useMemo(
    () => new Set((d?.scans ?? []).map(s => s.barcode)).size, [d?.scans]
  );

  const record = async (ev: React.FormEvent) => {
    ev.preventDefault();
    const barcode = scan.trim();
    if (!barcode) return;
    setScan('');
    setError(null);
    setNotice(null);
    try {
      await api.post(`/stock-counts/${countId}/scans`, {
        scans: [{ barcode, rackCode: rack || null, qty: qty === '' ? null : Number(qty) }]
      });
      setLastScan({ barcode, ok: true });
      setQty('');
      detail.reload();
    } catch (err) {
      setLastScan({ barcode, ok: false });
      setError(err instanceof ApiError ? err.message : String(err));
    }
  };

  const drop = async (scanId: number) => {
    setError(null);
    try {
      await api.del(`/stock-counts/${countId}/scans/${scanId}`);
      detail.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  };

  const answered = (d?.exceptions ?? []).filter(e => {
    const a = answers[key(e)];
    return a?.outcome && a.reason.trim().length > 0;
  }).length;
  const ready = !!d && d.exceptions.length === answered;

  const submit = async () => {
    if (!d || !ready) return;
    setError(null);
    try {
      const out = await api.post<{ countNo: string; variances: number; netValue: number; awaiting: string }>(
        `/stock-counts/${countId}/submit`,
        {
          decisions: d.exceptions.map(e => ({
            barcode: e.barcode, kind: e.kind,
            outcome: answers[key(e)]!.outcome,
            reason: answers[key(e)]!.reason.trim()
          }))
        }
      );
      setNotice(
        `${out.countNo} sent for approval — ${out.variances} difference(s), ` +
        `net ${money(out.netValue)}, waiting on ${out.awaiting}`
      );
      detail.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  };

  if (detail.loading) return <Shell onClose={onClose}><p className="p-3 text-slate-500">Loading…</p></Shell>;
  if (detail.error || !d) {
    return <Shell onClose={onClose}><p className="p-3 text-red-700">{detail.error ?? 'not found'}</p></Shell>;
  }

  return (
    <div className="flex flex-col h-full bg-[#ecf1f7] text-slate-800 text-xs">
      <ToolbarRibbon
        title={`${d.count.count_no} — Physical Stock Count`}
        actions={[
          ...(open ? [{
            key: 'save' as const, onRun: submit, disabled: !ready,
            hint: ready ? undefined : `${d.exceptions.length - answered} difference(s) still unanswered`
          }] : []),
          { key: 'print' as const, onRun: () => window.print() },
          { key: 'reset' as const, onRun: () => { onClose(); } }
        ]}
      />

      {(error || notice) && (
        <div className={`px-4 py-1.5 flex items-center gap-2 font-semibold ${
          error ? 'bg-red-600 text-white' : 'bg-emerald-600 text-white'
        }`}>
          {error ? <AlertTriangle className="w-4 h-4 shrink-0" /> : <CheckCircle2 className="w-4 h-4 shrink-0" />}
          <span>{error ?? notice}</span>
        </div>
      )}

      <div className="p-3 flex-1 overflow-y-auto max-w-6xl mx-auto w-full space-y-3 print-area">
        <button onClick={onClose} className="erp-btn no-print">
          <ArrowLeft className="w-3 h-3" /> All counts
        </button>

        <div className="bg-white rounded border border-[#b8c9dd] p-3 grid grid-cols-2 md:grid-cols-6 gap-3">
          <Field label="Count"><span className="font-mono text-blue-800">{d.count.count_no}</span></Field>
          <Field label="Date">{d.count.count_date}</Field>
          <Field label="Scope">
            {[d.count.rack_code && `Rack ${d.count.rack_code}`, d.count.quality,
              d.count.lot_no && `Lot ${d.count.lot_no}`].filter(Boolean).join(' · ') || 'everything'}
          </Field>
          <Field label="Expected"><span className="font-mono">{d.count.pieces_expected}</span></Field>
          <Field label="Counted"><span className="font-mono">{counted}</span></Field>
          <Field label="State"><StatusChip status={d.count.status} /></Field>
        </div>

        {open && (
          <form onSubmit={record}
                className="bg-white rounded border-2 border-blue-300 p-3 no-print
                           flex flex-wrap items-end gap-3">
            <div className="flex-1 min-w-[240px]">
              <label className="erp-label block text-blue-900 font-bold" htmlFor="count-scan">
                <ScanLine className="w-3.5 h-3.5 inline mr-1" />Scan the thaan
              </label>
              <input id="count-scan" autoFocus value={scan} onChange={e => setScan(e.target.value)}
                     placeholder="scan or type, then Enter"
                     className="erp-input w-full font-mono text-lg py-3" />
            </div>
            <div className="w-28">
              <label className="erp-label block" htmlFor="count-rack">Shelf</label>
              <input id="count-rack" value={rack} onChange={e => setRack(e.target.value)}
                     placeholder="A1" className="erp-input w-full font-mono text-lg py-3 uppercase" />
            </div>
            <div className="w-32">
              <label className="erp-label block" htmlFor="count-qty">Measured</label>
              <input id="count-qty" type="number" step="0.01" min="0" inputMode="decimal"
                     value={qty} onChange={e => setQty(e.target.value)}
                     placeholder="as booked"
                     className="erp-input w-full font-mono text-lg py-3 text-right" />
            </div>
            <button type="submit" className="erp-btn erp-btn-primary text-base py-3 px-6">Record</button>
            {lastScan && (
              <span className={`px-3 py-2 rounded font-bold font-mono ${
                lastScan.ok ? 'bg-emerald-100 text-emerald-900 border border-emerald-400'
                            : 'bg-red-100 text-red-900 border border-red-400'
              }`}>
                {lastScan.ok ? '✓' : '✕'} {lastScan.barcode}
              </span>
            )}
          </form>
        )}

        {open && d.exceptions.length > 0 && (
          <div className="bg-white rounded border border-[#b8c9dd] overflow-hidden">
            <div className="bg-amber-100 border-b border-amber-300 px-2 py-1.5 font-bold text-amber-900">
              {d.exceptions.length} difference(s) — every one needs an answer and a reason
              {answered > 0 && ` · ${answered} answered`}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-slate-100 border-b border-slate-300 text-left">
                  <tr>
                    <th className="px-2 py-1.5 font-bold">Barcode</th>
                    <th className="px-2 py-1.5 font-bold">What</th>
                    <th className="px-2 py-1.5 font-bold text-right">Books</th>
                    <th className="px-2 py-1.5 font-bold text-right">Floor</th>
                    <th className="px-2 py-1.5 font-bold text-right">Value</th>
                    <th className="px-2 py-1.5 font-bold">Do what</th>
                    <th className="px-2 py-1.5 font-bold">Why</th>
                  </tr>
                </thead>
                <tbody>
                  {d.exceptions.map(e => {
                    const a = answers[key(e)];
                    const options = e.piece_id
                      ? LEGAL[e.kind].filter(o => o !== 'needs_inward')
                      : LEGAL[e.kind].filter(o => o === 'needs_inward' || o === 'investigate');
                    return (
                      <tr key={key(e)} className="border-b border-slate-100 align-top">
                        <td className="px-2 py-1 font-mono text-blue-800">{e.barcode}</td>
                        <td className="px-2 py-1">{KIND_LABEL[e.kind]}</td>
                        <td className="px-2 py-1 text-right font-mono">
                          {e.system_qty === null ? '—' : Number(e.system_qty).toFixed(2)}
                          {e.system_rack && <div className="text-slate-500">{e.system_rack}</div>}
                        </td>
                        <td className="px-2 py-1 text-right font-mono">
                          {e.counted_qty === null ? '—' : Number(e.counted_qty).toFixed(2)}
                          {e.counted_rack && <div className="text-slate-500">{e.counted_rack}</div>}
                        </td>
                        <td className={`px-2 py-1 text-right font-mono ${
                          Number(e.value) < 0 ? 'text-red-700' : Number(e.value) > 0 ? 'text-emerald-700' : ''
                        }`}>{Number(e.value) === 0 ? '—' : money(e.value)}</td>
                        <td className="px-2 py-1">
                          <select value={a?.outcome ?? ''} className="erp-input w-full"
                                  onChange={ev => setAnswers(p => ({
                                    ...p,
                                    [key(e)]: { outcome: ev.target.value as Outcome, reason: a?.reason ?? '' }
                                  }))}>
                            <option value="">— choose —</option>
                            {options.map(o => (
                              <option key={o} value={o}>{OUTCOME_LABEL[o]}</option>
                            ))}
                          </select>
                        </td>
                        <td className="px-2 py-1">
                          <input value={a?.reason ?? ''} maxLength={200}
                                 placeholder="required"
                                 className={`erp-input w-full ${
                                   a?.outcome && !a.reason.trim() ? 'border-red-400' : ''}`}
                                 onChange={ev => setAnswers(p => ({
                                   ...p,
                                   [key(e)]: { outcome: (a?.outcome ?? '') as Outcome, reason: ev.target.value }
                                 }))} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {open && d.exceptions.length === 0 && counted > 0 && (
          <p className="text-emerald-800 font-semibold px-1">
            Everything scanned so far matches the books. Keep going, or submit when the shelf is done.
          </p>
        )}

        {(held || d.count.status === 'approved' || d.count.status === 'cancelled'
          || d.count.status === 'rejected') && d.variances.length > 0 && (
          <div className="bg-white rounded border border-[#b8c9dd] overflow-hidden">
            <div className="bg-slate-100 border-b border-slate-300 px-2 py-1.5 font-bold">
              Variance report — {d.count.variances} difference(s), net {money(d.count.net_value)}
              {d.count.status === 'cancelled' && ' (this count was reversed)'}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="border-b border-slate-200 text-left text-slate-600">
                  <tr>
                    <th className="px-2 py-1">Barcode</th><th className="px-2 py-1">Quality</th>
                    <th className="px-2 py-1">What</th><th className="px-2 py-1">Decided</th>
                    <th className="px-2 py-1 text-right">Books</th><th className="px-2 py-1 text-right">Floor</th>
                    <th className="px-2 py-1 text-right">Value</th><th className="px-2 py-1">Why</th>
                  </tr>
                </thead>
                <tbody>
                  {d.variances.map((v, i) => (
                    <tr key={i} className={`border-b border-slate-100 ${
                      d.count.status === 'cancelled' ? 'text-slate-400 line-through' : ''
                    }`}>
                      <td className="px-2 py-1 font-mono text-blue-800">{v.barcode}</td>
                      <td className="px-2 py-1">{v.quality ?? '—'}</td>
                      <td className="px-2 py-1">{KIND_LABEL[v.kind as Kind] ?? v.kind}</td>
                      <td className="px-2 py-1">{OUTCOME_LABEL[v.outcome as Outcome] ?? v.outcome}</td>
                      <td className="px-2 py-1 text-right font-mono">
                        {v.system_qty === null ? '—' : Number(v.system_qty).toFixed(2)}</td>
                      <td className="px-2 py-1 text-right font-mono">
                        {v.counted_qty === null ? '—' : Number(v.counted_qty).toFixed(2)}</td>
                      <td className={`px-2 py-1 text-right font-mono ${
                        Number(v.value) < 0 ? 'text-red-700' : ''}`}>
                        {Number(v.value) === 0 ? '—' : money(v.value)}</td>
                      <td className="px-2 py-1 text-slate-600">{v.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {held && (
              <p className="px-2 py-2 bg-amber-50 text-amber-900 border-t border-amber-200">
                Nothing has moved yet. Stock and the ledger change only when a second person
                approves this in the Approvals screen.
              </p>
            )}
          </div>
        )}

        <div className="bg-white rounded border border-[#b8c9dd] overflow-hidden">
          <div className="bg-slate-100 border-b border-slate-300 px-2 py-1.5 font-bold
                          flex items-center justify-between">
            <span>Count sheet — {d.sheet.length} piece(s) expected</span>
            <button onClick={() => window.print()} className="erp-btn py-0.5 no-print">
              <Printer className="w-3 h-3" /> Print
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-slate-200 text-left text-slate-600">
                <tr>
                  <th className="px-2 py-1">Shelf</th><th className="px-2 py-1">Barcode</th>
                  <th className="px-2 py-1">Quality</th><th className="px-2 py-1">Lot</th>
                  <th className="px-2 py-1 text-right">Books say</th>
                  <th className="px-2 py-1">Counted</th>
                </tr>
              </thead>
              <tbody>
                {d.sheet.map(s => (
                  <tr key={s.barcode} className="border-b border-slate-100">
                    <td className="px-2 py-1 font-mono">{s.rack_code ?? '—'}</td>
                    <td className="px-2 py-1 font-mono text-blue-800">{s.barcode}</td>
                    <td className="px-2 py-1">{s.quality}</td>
                    <td className="px-2 py-1">{s.lot_no}</td>
                    <td className="px-2 py-1 text-right font-mono">{Number(s.qty).toFixed(2)}</td>
                    <td className="px-2 py-1">
                      {s.scanned
                        ? <span className="text-emerald-700 font-bold">✓</span>
                        : <span className="text-slate-300">☐</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {open && d.scans.length > 0 && (
          <div className="bg-white rounded border border-[#b8c9dd] overflow-hidden no-print">
            <div className="bg-slate-100 border-b border-slate-300 px-2 py-1.5 font-bold">
              {d.scans.length} scan(s) recorded — a mis-scan can be taken back until this is submitted
            </div>
            <table className="w-full">
              <tbody>
                {d.scans.map(s => (
                  <tr key={s.id} className="border-b border-slate-100">
                    <td className="px-2 py-1 font-mono text-blue-800">{s.barcode}</td>
                    <td className="px-2 py-1 font-mono">{s.rack_code ?? '—'}</td>
                    <td className="px-2 py-1 font-mono text-right w-24">
                      {s.qty === null ? 'as booked' : Number(s.qty).toFixed(2)}</td>
                    <td className="px-2 py-1 text-right w-12">
                      <button onClick={() => drop(s.id)} className="erp-btn py-0.5" title="remove">
                        <Trash2 className="w-3 h-3 text-red-600" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};

// ------------------------------------------------------------------ shared --

const Shell: React.FC<{ onClose: () => void; children: React.ReactNode }> = ({ onClose, children }) => (
  <div className="flex flex-col h-full bg-[#ecf1f7] text-slate-800 text-xs">
    <ToolbarRibbon title="Physical Stock Count" actions={[{ key: 'reset', onRun: onClose }]} />
    {children}
  </div>
);

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div>
    <span className="erp-label block">{label}</span>
    <span className="font-semibold">{children}</span>
  </div>
);

const CHIP: Record<string, string> = {
  draft: 'bg-slate-200 text-slate-800 border-slate-400',
  pending_approval: 'bg-amber-100 text-amber-900 border-amber-400',
  approved: 'bg-emerald-100 text-emerald-900 border-emerald-400',
  rejected: 'bg-red-100 text-red-900 border-red-400',
  cancelled: 'bg-slate-100 text-slate-500 border-slate-300'
};
const CHIP_LABEL: Record<string, string> = {
  draft: 'Counting',
  pending_approval: 'Waiting for approval',
  approved: 'Approved',
  rejected: 'Rejected',
  cancelled: 'Reversed'
};

const StatusChip: React.FC<{ status: string }> = ({ status }) => (
  <span className={`px-1.5 py-0.5 rounded border font-bold ${CHIP[status] ?? CHIP.draft}`}>
    {CHIP_LABEL[status] ?? status}
  </span>
);
