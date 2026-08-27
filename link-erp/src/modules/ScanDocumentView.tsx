import React, { useState } from 'react';
import { ToolbarRibbon } from '../components/ToolbarRibbon';
import { useApi } from '../lib/useApi';
import { useLang } from '../lib/i18n';
import { api } from '../lib/api';
import type { LedgerRow, Page, PieceRow } from '../lib/api';
import { QrCode, AlertTriangle, CheckCircle2, Trash2, ListChecks, History } from 'lucide-react';
import { enqueue, isOnline } from '../lib/offlineQueue';

/**
 * Issue-to-dyeing and dispatch are the same interaction — pick a counterparty,
 * scan pieces, post — so they are one screen with two specs rather than two
 * near-identical modules.
 */
type Kind = 'issue' | 'dispatch' | 'pack' | 'grey_return' | 'dyeing_return' | 'customer_return' | 'write_off';

interface Spec {
  title: string;
  path: string;
  /** null when the document has no counterparty, as cut/pack does not. */
  partyLabel: string | null;
  eligibleStatuses: string[];
  needsRate: boolean;
  needsInvoice?: boolean;
  needsReason?: boolean;
  counterpartyNatures: string[];
}

const SPECS: Record<Kind, Spec> = {
  grey_return: {
    title: 'Grey Return to Weaver',
    path: '/grey-returns',
    partyLabel: 'Weaver',
    eligibleStatuses: ['grey_in_stock'],
    needsRate: false,
    needsReason: true,
    counterpartyNatures: ['sundry_creditor_raw']
  },
  dyeing_return: {
    title: 'Defective Return to Process House',
    path: '/dyeing-returns',
    partyLabel: 'Process House',
    eligibleStatuses: ['received_finish'],
    needsRate: false,
    needsReason: true,
    counterpartyNatures: ['sundry_creditor_process']
  },
  issue: {
    title: 'Issue To Dyeing (Job Order Challan)',
    path: '/dyeing-issues',
    partyLabel: 'Process House',
    eligibleStatuses: ['grey_in_stock'],
    needsRate: true,
    counterpartyNatures: ['sundry_creditor_process']
  },

  write_off: {
    title: 'Write-off / Damage',
    path: '/write-offs',
    partyLabel: null,
    eligibleStatuses: ['grey_in_stock', 'received_finish'],
    needsRate: false,
    needsReason: true,
    counterpartyNatures: []
  },
  customer_return: {
    title: 'Customer Return',
    path: '/customer-returns',
    partyLabel: 'Customer',
    eligibleStatuses: ['dispatched'],
    needsRate: false,
    needsInvoice: true,
    needsReason: true,
    counterpartyNatures: ['sundry_debtor_finish']
  },
  dispatch: {
    title: 'Dispatch / Delivery Challan',
    path: '/dispatches',
    partyLabel: 'Customer',
    eligibleStatuses: ['received_finish', 'cut_packed'],
    needsRate: true,
    counterpartyNatures: ['sundry_debtor_finish']
  },
  pack: {
    title: 'Cut / Pack',
    path: '/cut-pack',
    partyLabel: null,
    eligibleStatuses: ['received_finish'],
    needsRate: false,
    counterpartyNatures: []
  }
};

const today = () => new Date().toISOString().slice(0, 10);

interface Line {
  barcode: string; quality: string; grade: string; qty: number; rate: number;
  soLineId?: string;
  /** Which bale this thaan was strapped into; the customer reads it, not us. */
  baleNo?: number;
}

interface SalesOrderRow {
  id: string; order_no: string; party_id: string; status: string;
  lines: { id: string; sno: number; quality: string; grade_code: string;
    qty: number; dispatched_qty: number; rate: number }[];
}

export const ScanDocumentView: React.FC<{ kind: Kind }> = ({ kind }) => {
  const spec = SPECS[kind];
  // The floor reads Hindi or Gujarati first. A missing key renders the
  // English, so a half-translated screen still works.
  const { t } = useLang();
  const [partyId, setPartyId] = useState('');
  const [invoiceId, setInvoiceId] = useState('');
  const [challanNo, setChallanNo] = useState('');
  const [challanDate, setChallanDate] = useState(today());
  const [reason, setReason] = useState('');
  const [rate, setRate] = useState(kind === 'issue' ? 18 : 72);
  const [lines, setLines] = useState<Line[]>([]);
  const [scan, setScan] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [pickFilter, setPickFilter] = useState('');
  const [flowFor, setFlowFor] = useState<string | null>(null);

  const ledgers = useApi<LedgerRow[]>('/ledgers');
  const controls = useApi<{ id: string; nature: string }[]>('/control-accounts');
  const eligible = useApi<PieceRow[]>(
    `/pieces?status=${spec.eligibleStatuses.join(',')}&limit=100000`
  );
  const salesOrders = useApi<Page<SalesOrderRow>>('/sales-orders?limit=100000');

  const allowedControlIds = new Set(
    (controls.data ?? []).filter(c => spec.counterpartyNatures.includes(c.nature)).map(c => c.id)
  );
  const parties = (ledgers.data ?? []).filter(l => allowedControlIds.has(l.control_account_id));
  const invoices = useApi<{ rows: { id: string; invoice_no: string; party_id: string; status: string }[] }>('/sales-invoices?limit=100000');
  const partyInvoices = (invoices.data?.rows ?? []).filter(i => i.party_id === partyId && i.status === 'approved');
  const openOrderLines = (salesOrders.data?.rows ?? [])
    .filter(order => order.party_id === partyId && ['approved', 'partly_done'].includes(order.status))
    .flatMap(order => order.lines
      .filter(line => Number(line.dispatched_qty) < Number(line.qty))
      .map(line => ({ ...line, orderNo: order.order_no })));

  // Already-scanned pieces stay listed, checked, so the picker also shows what
  // is on the challan rather than silently hiding it.
  const pickable = (eligible.data ?? []).filter(p => {
    const needle = pickFilter.trim().toLowerCase();
    if (!needle) return true;
    return [p.barcode, p.quality, p.lot_no, p.rack_code, p.grade_code]
      .some(v => (v ?? '').toString().toLowerCase().includes(needle));
  });

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = (e: React.FormEvent) => {
    e.preventDefault();
    const code = scan.trim();
    if (!code) return;
    setScan('');
    if (lines.some(l => l.barcode === code)) {
      setNotice(`${code} is already on this challan`);
      return;
    }
    const piece = (eligible.data ?? []).find(p => p.barcode === code);
    if (!piece) {
      setNotice(`${code} is not available for this document`);
      return;
    }
    setNotice(null);
    const match = kind === 'dispatch'
      ? openOrderLines.find(line => line.quality === piece.quality &&
          line.grade_code === piece.grade_code &&
          Number(line.qty) - Number(line.dispatched_qty) >= Number(piece.current_qty))
      : undefined;
    setLines(prev => [...prev, {
      barcode: piece.barcode, quality: piece.quality, grade: piece.grade_code,
      qty: piece.current_qty, rate: match ? Number(match.rate) : rate,
      soLineId: match?.id
    }]);
  };

  const save = async () => {
    const missing = [
      lines.length === 0 ? 'scan at least one piece' : '',
      spec.partyLabel && !partyId ? `pick a ${spec.partyLabel.toLowerCase()}` : '',
      kind !== 'write_off' && kind !== 'pack' && !challanNo ? 'enter a challan number' : '',
      spec.needsInvoice && !invoiceId ? 'select the original invoice' : '',
      spec.needsReason && !reason.trim() ? 'enter the reason' : '',
    ].filter(Boolean);
    if (missing.length) {
      setNotice(missing.join(', '));
      return;
    }

    const body = kind === 'issue'
      ? {
          processHouseId: partyId, entryDate: challanDate, challanNo, challanDate,
          lotNo: '', jobRate: rate, barcodes: lines.map(l => l.barcode)
        }

      : kind === 'customer_return'
      ? {
          customerId: partyId, againstInvoiceId: invoiceId, entryDate: challanDate, challanNo, reason: reason.trim(),
          lines: lines.map(l => ({ barcode: l.barcode, qty: l.qty }))
        }
      : kind === 'grey_return'
      ? {
          weaverId: partyId, entryDate: challanDate, challanNo, challanDate, reason: reason.trim(),
          lines: lines.map(l => ({ barcode: l.barcode, qty: l.qty }))
        }
      : kind === 'dyeing_return'
      ? {
          processHouseId: partyId, entryDate: challanDate, challanNo, challanDate, reason: reason.trim(),
          lines: lines.map(l => ({ barcode: l.barcode, qty: l.qty }))
        }
      : kind === 'write_off'
      ? {
          entryDate: challanDate, reason: reason.trim(),
          lines: lines.map(l => ({ barcode: l.barcode }))
        }
      : kind === 'pack'
        ? { barcodes: lines.map(l => l.barcode), note: challanNo }
        : {
            partyId, challanNo, challanDate,
            lines: lines.map(l => ({
              barcode: l.barcode, rate: l.rate, soLineId: l.soLineId || null,
              baleNo: l.baleNo ?? null
            }))
          };

    // A dropped signal must not lose the scan; queue it and flush on reconnect.
    if (!isOnline()) {
      await enqueue(spec.path, body);
      setNotice(`No network — ${lines.length} piece(s) queued and will post when the signal returns`);
      setLines([]);
      setChallanNo('');
      setReason('');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const out = await api.post<any>(spec.path, body);
      setNotice(
        out.status === 'pending_approval'
          ? `${out.entryNo} submitted — awaiting a second approval before stock or accounts move`
        : kind === 'issue'
          ? `Challan ${out.entryNo} posted — ${out.pieces} pieces sent out`
          : kind === 'pack'
            ? `${out.pieces} pieces packed, ${out.qty} mtr`
            : `Dispatch ${out.challanNo} posted — ${out.pieces} pieces`
      );
      setLines([]);
      setChallanNo('');
      setReason('');
      eligible.reload();
    } catch (e: any) {
      if (e.message === 'Failed to fetch' || e.message === 'NetworkError') {
        await enqueue(spec.path, body);
        setNotice(`Connection dropped — ${lines.length} piece(s) queued to sync in background`);
        setLines([]);
        setChallanNo('');
        setReason('');
      } else {
        setError(e.message || String(e));
      }
    } finally {
      setBusy(false);
    }
  };

  const total = lines.reduce((a, l) => ({ qty: a.qty + l.qty, value: a.value + l.qty * l.rate }),
    { qty: 0, value: 0 });

  return (
    <div className="flex flex-col h-full bg-[#ecf1f7] text-slate-800 text-xs">
      <ToolbarRibbon
        title={t(spec.title)}
        onSave={save}
        onNew={() => { setLines([]); setChallanNo(''); setReason(''); setNotice(null); }}
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

      <div className="p-3 flex-1 overflow-y-auto max-w-7xl mx-auto w-full space-y-3">
        <div className="bg-white rounded border border-[#b8c9dd] p-3 grid grid-cols-1 md:grid-cols-12 gap-2.5">
          {spec.partyLabel && (
            <div className="md:col-span-5">
              <label htmlFor="scan-party" className="erp-label block text-red-700 font-bold">* {t(spec.partyLabel)}</label>
              <select id="scan-party" value={partyId} onChange={e => {
                setPartyId(e.target.value);
                if (kind === 'dispatch') setLines(old => old.map(line => ({ ...line, soLineId: undefined })));
              }} className="erp-input w-full">
                <option value="">— select —</option>
                {parties.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
          )}
          {kind !== 'write_off' && (
            <div className={spec.partyLabel ? 'md:col-span-3' : 'md:col-span-8'}>
            <label htmlFor="scan-challan" className={`erp-label block ${spec.partyLabel ? 'text-red-700 font-bold' : ''}`}>
              {spec.partyLabel ? '* Challan No.' : 'Packing note'}
            </label>
            <input id="scan-challan" value={challanNo} onChange={e => setChallanNo(e.target.value)}
                   className="erp-input w-full font-mono"
                   placeholder={spec.partyLabel ? '' : 'e.g. folded, 4 bales'} />
            </div>
          )}

          {spec.needsInvoice && (
            <div className="md:col-span-2">
              <label htmlFor="scan-invoice" className="erp-label block text-red-700 font-bold">* Against Invoice</label>
              <select id="scan-invoice" value={invoiceId} onChange={e => setInvoiceId(e.target.value)} className="erp-input w-full">
                <option value="">— select —</option>
                {partyInvoices.map(i => <option key={i.id} value={i.id}>{i.invoice_no}</option>)}
              </select>
            </div>
          )}

          {spec.needsReason && (
            <div className={kind === 'write_off' ? 'md:col-span-8' : 'md:col-span-5'}>
              <label htmlFor="scan-reason" className="erp-label block text-red-700 font-bold">* Reason</label>
              <input id="scan-reason" value={reason} onChange={e => setReason(e.target.value)} maxLength={200}
                     className="erp-input w-full" placeholder={t('e.g. defect, damage, wrong colour')} />
            </div>
          )}

          <div className="md:col-span-2">
            <label htmlFor="scan-date" className="erp-label block">Date</label>
            <input id="scan-date" type="date" value={challanDate} onChange={e => setChallanDate(e.target.value)}
                   className="erp-input w-full" />
          </div>

          {spec.needsRate && (
            <div className="md:col-span-2">
              <label htmlFor="scan-rate" className="erp-label block">
                {kind === 'issue' ? 'Job Rate ₹' : 'Sale Rate ₹'}
              </label>
              <input id="scan-rate" type="number" step="0.01" value={rate}
                     onChange={e => setRate(Number(e.target.value))}
                     className="erp-input w-full font-mono" />
            </div>
          )}
        </div>

        {/* The most-used control on the floor, and the one most often reached
            for on a phone with one hand. Full width and thumb-sized on a
            small screen; unchanged at a desk. */}
        <form onSubmit={add} className="bg-white rounded border-2 border-blue-300 p-3
                                        flex flex-wrap items-end gap-2">
          <div className="flex-1 min-w-[220px]">
            <label className="font-bold text-blue-900 flex items-center gap-1.5 mb-1" htmlFor="scan">
              <QrCode className="w-4 h-4 text-blue-700" />Scan barcode
            </label>
            <input id="scan" autoFocus inputMode="text" autoComplete="off"
                   value={scan} onChange={e => setScan(e.target.value)}
                   placeholder={t('scan or type, then Enter')}
                   className="erp-input font-mono w-full text-base py-3 md:text-xs md:py-1" />
          </div>
          <button type="submit" className="erp-btn erp-btn-primary min-h-11 px-5 md:min-h-0">
            Add
          </button>
          {/* Scanning two hundred thaans one at a time is not a workflow. The
              picker is beside the scanner, not instead of it. */}
          <button type="button" onClick={() => setPicking(v => !v)}
                  className="erp-btn min-h-11 px-4 md:min-h-0">
            <ListChecks className="w-3.5 h-3.5" />
            {picking ? 'Hide list' : 'Pick from stock'}
          </button>
          <span className="text-slate-500 basis-full md:basis-auto md:self-center">
            {(eligible.data ?? []).length} pieces eligible
          </span>
        </form>

        {picking && (
          <div className="bg-white rounded border border-[#b8c9dd] overflow-hidden">
            <div className="bg-slate-100 border-b border-slate-300 px-2 py-1.5
                            flex flex-wrap items-center gap-2">
              <span className="font-bold">{t('Pick from stock')}</span>
              <input value={pickFilter} onChange={e => setPickFilter(e.target.value)}
                     aria-label="Filter stock"
                     placeholder={t('quality, lot, rack or barcode')}
                     className="erp-input font-mono flex-1 min-w-[10rem]" />
              <button onClick={() => {
                const chosen = pickable.filter(p => !lines.some(l => l.barcode === p.barcode));
                setLines(prev => [...prev, ...chosen.map(p => ({
                  barcode: p.barcode, quality: p.quality, grade: p.grade_code,
                  qty: Number(p.current_qty), rate
                }))]);
                setNotice(`${chosen.length} piece(s) added from stock`);
              }} className="erp-btn erp-btn-primary" disabled={pickable.length === 0}>
                Add all {pickable.length}
              </button>
            </div>
            <div className="max-h-64 overflow-y-auto">
              <table className="w-full">
                <tbody>
                  {pickable.length === 0 && (
                    <tr><td className="px-2 py-4 text-center text-slate-400">
                      Nothing eligible matches that.
                    </td></tr>
                  )}
                  {pickable.slice(0, 300).map(p => {
                    const on = lines.some(l => l.barcode === p.barcode);
                    return (
                      <tr key={p.barcode} className="border-b border-slate-100">
                        <td className="px-2 py-1.5 w-10">
                          <input type="checkbox" className="w-5 h-5" checked={on}
                                 aria-label={`Pick ${p.barcode}`}
                                 onChange={() => setLines(prev => on
                                   ? prev.filter(l => l.barcode !== p.barcode)
                                   : [...prev, { barcode: p.barcode, quality: p.quality,
                                                 grade: p.grade_code, qty: Number(p.current_qty), rate }])} />
                        </td>
                        <td className="px-2 py-1.5 font-mono text-blue-800">{p.barcode}</td>
                        <td className="px-2 py-1.5">{p.quality}</td>
                        <td className="px-2 py-1.5 text-slate-500">
                          {p.lot_no}{p.rack_code ? ` · ${p.rack_code}` : ''}
                        </td>
                        <td className="px-2 py-1.5 text-right font-mono">
                          {Number(p.current_qty).toFixed(2)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {flowFor && <FlowPanel barcode={flowFor} onClose={() => setFlowFor(null)} />}

        <div className="bg-white rounded border border-[#b8c9dd] overflow-hidden">
          <div className="overflow-x-auto">
          <table className="w-full min-w-[36rem]">
            <thead className="bg-slate-100 border-b border-slate-300 text-left">
              <tr>
                <th className="px-2 py-1.5 font-bold">Sno</th>
                <th className="px-2 py-1.5 font-bold">{t('Barcode')}</th>
                <th className="px-2 py-1.5 font-bold">{t('Quality')}</th>
                <th className="px-2 py-1.5 font-bold text-right">Qty</th>
                {spec.needsRate && <>
                  <th className="px-2 py-1.5 font-bold text-right">Rate</th>
                  <th className="px-2 py-1.5 font-bold text-right">{t('Amount')}</th>
                </>}
                {kind === 'dispatch' && <th className="px-2 py-1.5 font-bold w-20">Bale</th>}
                {kind === 'dispatch' && <th className="px-2 py-1.5 font-bold">Sales order allocation</th>}
                <th className="px-2 py-1.5"></th>
              </tr>
            </thead>
            <tbody>
              {lines.length === 0 && (
                <tr><td colSpan={(spec.needsRate ? 7 : 5) + (kind === 'dispatch' ? 1 : 0)} className="px-2 py-6 text-center text-slate-400">
                  Scan a barcode to begin
                </td></tr>
              )}
              {lines.map((l, i) => (
                <tr key={l.barcode} className="border-b border-slate-100">
                  <td className="px-2 py-1">{i + 1}</td>
                  <td className="px-2 py-1 font-mono text-blue-800">{l.barcode}</td>
                  <td className="px-2 py-1">{l.quality}</td>
                  <td className="px-2 py-1 text-right font-mono">{l.qty.toFixed(2)}</td>
                  {spec.needsRate && <>
                    <td className="px-2 py-1 text-right font-mono">{l.rate.toFixed(2)}</td>
                    <td className="px-2 py-1 text-right font-mono">₹{(l.qty * l.rate).toFixed(2)}</td>
                  </>}
                  {kind === 'dispatch' && <td className="px-2 py-1">
                    <input type="number" min="1" max="9999" inputMode="numeric"
                           aria-label={`Bale number for ${l.barcode}`}
                           value={l.baleNo ?? ''} className="erp-input w-16 text-right font-mono"
                           onChange={e => setLines(prev => prev.map((line, j) => j === i
                             ? { ...line, baleNo: e.target.value ? Number(e.target.value) : undefined }
                             : line))} />
                  </td>}
                  {kind === 'dispatch' && <td className="px-2 py-1">
                    <select aria-label={`Sales order for ${l.barcode}`} value={l.soLineId ?? ''}
                      onChange={e => {
                        const chosen = openOrderLines.find(line => line.id === e.target.value);
                        setLines(old => old.map((line, index) => index === i
                          ? { ...line, soLineId: e.target.value || undefined,
                              rate: chosen ? Number(chosen.rate) : line.rate }
                          : line));
                      }} className="erp-input min-w-56">
                      <option value="">Ad-hoc / no sales order</option>
                      {openOrderLines
                        .filter(line => line.quality === l.quality && line.grade_code === l.grade)
                        .map(line => <option key={line.id} value={line.id}>
                          {line.orderNo} · line {line.sno} · {(Number(line.qty) - Number(line.dispatched_qty)).toFixed(2)} m left
                        </option>)}
                    </select>
                  </td>}
                  <td className="px-2 py-1 text-right whitespace-nowrap">
                    <button onClick={() => setFlowFor(l.barcode)} title="Where this thaan has been"
                            aria-label={`Journey of ${l.barcode}`}
                            className="text-blue-700 hover:text-blue-900 min-h-11 min-w-11
                                       inline-flex items-center justify-center md:min-h-0 md:min-w-0">
                      <History className="w-4 h-4" />
                    </button>
                    <button onClick={() => setLines(prev => prev.filter((_, j) => j !== i))}
                            title="Remove line" aria-label={`Remove ${l.barcode}`}
                            className="text-red-600 hover:text-red-800 min-h-11 min-w-11
                                       inline-flex items-center justify-center md:min-h-0 md:min-w-0">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
          <div className="bg-slate-50 border-t border-slate-300 px-3 py-2 flex flex-wrap
                          items-center justify-end gap-3 md:gap-6 font-bold">
            <span>Pieces: {lines.length}</span>
            <span>Qty: {total.qty.toFixed(2)}</span>
            {spec.needsRate
              ? <span>Value: ₹{total.value.toFixed(2)}</span>
              : <span className="text-slate-600">Value is taken from the locked stock or original invoice</span>}
            <button onClick={save} disabled={busy}
                    className="erp-btn erp-btn-primary font-bold disabled:opacity-60
                               min-h-11 px-5 basis-full md:basis-auto md:min-h-0 justify-center">
              {busy ? 'Posting…' : 'Post Challan'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

/**
 * Where a thaan has been, beside the document rather than in a separate report.
 * A storekeeper holding a barcode gun should not have to leave the challan to
 * find out why the piece in their hand is not where the paper says it is.
 */
const FlowPanel: React.FC<{ barcode: string; onClose: () => void }> = ({ barcode, onClose }) => {
  const { t } = useLang();
  const flow = useApi<{
    event: string; from_status: string | null; to_status: string;
    qty_before: number; qty_after: number; counterparty: string | null;
    doc_type: string; occurred_at: string;
  }[]>(`/pieces/${encodeURIComponent(barcode)}/flow`, [barcode]);

  return (
    <div className="bg-white rounded border border-[#b8c9dd] overflow-hidden">
      <div className="bg-slate-100 border-b border-slate-300 px-2 py-1.5 flex items-center gap-2">
        <History className="w-3.5 h-3.5 text-blue-700" />
        <span className="font-bold">Journey of <span className="font-mono">{barcode}</span></span>
        <button onClick={onClose} className="erp-btn py-0.5 ml-auto">{t('Close')}</button>
      </div>
      {flow.loading && <p className="px-2 py-3 text-slate-500">{t('Loading…')}</p>}
      {flow.error && <p className="px-2 py-3 text-red-700">{flow.error}</p>}
      {!flow.loading && (flow.data ?? []).length === 0 && (
        <p className="px-2 py-3 text-slate-500">{t('Nothing has happened to this thaan yet.')}</p>
      )}
      {(flow.data ?? []).length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="border-b border-slate-200 text-left text-slate-600">
              <tr>
                <th className="px-2 py-1">When</th><th className="px-2 py-1">What</th>
                <th className="px-2 py-1">From → to</th>
                <th className="px-2 py-1 text-right">Qty</th>
                <th className="px-2 py-1">With</th><th className="px-2 py-1">{t('Document')}</th>
              </tr>
            </thead>
            <tbody>
              {(flow.data ?? []).map((e, i) => (
                <tr key={i} className="border-b border-slate-100">
                  <td className="px-2 py-1 whitespace-nowrap">
                    {new Date(e.occurred_at).toLocaleDateString('en-IN')}
                  </td>
                  <td className="px-2 py-1 font-semibold">{e.event}</td>
                  <td className="px-2 py-1 text-slate-600">
                    {(e.from_status ?? '—').replace(/_/g, ' ')} → {e.to_status.replace(/_/g, ' ')}
                  </td>
                  <td className="px-2 py-1 text-right font-mono">
                    {Number(e.qty_before).toFixed(2)} → {Number(e.qty_after).toFixed(2)}
                  </td>
                  <td className="px-2 py-1">{e.counterparty ?? '—'}</td>
                  <td className="px-2 py-1 text-slate-500">{e.doc_type.replace(/_/g, ' ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
