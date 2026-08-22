import React, { useMemo, useState } from 'react';
import { ToolbarRibbon } from '../components/ToolbarRibbon';
import { useApi, useSubmit } from '../lib/useApi';
import { api, ApiError, STATUS_LABEL, type PieceRow, type Session } from '../lib/api';
import { Scissors, Merge, AlertTriangle, CheckCircle2, Trash2, Plus, Undo2 } from 'lucide-react';

/**
 * Cutting a thaan, and putting short ends back together.
 *
 * The arithmetic is the whole risk here: an operator who keys 40 + 40 against
 * a 118 metre roll must be told about the missing 38 before saving, not after
 * the stock has gone wrong. The remainder is on screen at all times and the
 * Save button stays disabled until it is nil.
 */

const today = () => new Date().toISOString().slice(0, 10);
const CUTTABLE = ['grey_in_stock', 'received_finish', 'cut_packed'];

const money = (n: number) => `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

interface SplitResult {
  entryNo: string; from: string; qty: number;
  pieces: { barcode: string; qty: number; cost: number }[];
}

interface MergeResult {
  entryNo: string; into: string; qty: number;
  from: { barcode: string; qty: number }[];
}

interface LineageRow {
  regroup_id: string;
  entry_no: string; entry_date: string; kind: string; reason: string;
  from_barcode: string; to_barcode: string; qty: number; cost: number;
  doc_status: string;
}

/** Reversing a posted stock document is an accounting act, as it is everywhere else. */
const MAY_UNDO = ['owner', 'accounts'];

export const PieceRegroupView: React.FC<{ session?: Session }> = ({ session }) => {
  const [mode, setMode] = useState<'split' | 'merge'>('split');
  return (
    <div className="flex flex-col h-full bg-[#ecf1f7] text-slate-800 text-xs">
      <div className="bg-[#cbd5e1] border-b border-[#94a3b8] px-3 py-1 flex gap-1">
        {(['split', 'merge'] as const).map(m => (
          <button key={m} onClick={() => setMode(m)}
                  className={`px-3 py-1 rounded-t font-bold flex items-center gap-1.5 ${
                    mode === m ? 'bg-[#ecf1f7] text-blue-900' : 'text-slate-600 hover:text-slate-900'
                  }`}>
            {m === 'split' ? <Scissors className="w-3.5 h-3.5" /> : <Merge className="w-3.5 h-3.5" />}
            {m === 'split' ? 'Cut A Thaan' : 'Join Short Ends'}
          </button>
        ))}
      </div>
      {mode === 'split' ? <SplitPanel session={session} /> : <MergePanel />}
    </div>
  );
};

// ------------------------------------------------------------------- split --

interface Child { barcode: string; qty: string }

const SplitPanel: React.FC<{ session?: Session }> = ({ session }) => {
  const [scan, setScan] = useState('');
  const [parent, setParent] = useState<PieceRow | null>(null);
  const [children, setChildren] = useState<Child[]>([{ barcode: '', qty: '' }, { barcode: '', qty: '' }]);
  const [lossQty, setLossQty] = useState('');
  const [entryDate, setEntryDate] = useState(today());
  const [reason, setReason] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [looking, setLooking] = useState(false);

  const { submit, busy, error, clearError } = useSubmit<unknown, SplitResult>(
    parent ? `/pieces/${encodeURIComponent(parent.barcode)}/split` : '/pieces/-/split'
  );

  const lineage = useApi<LineageRow[]>(
    parent ? `/pieces/${encodeURIComponent(parent.barcode)}/lineage` : null, [parent?.id]
  );

  const entered = useMemo(
    () => children.reduce((sum, c) => sum + (Number(c.qty) || 0), 0),
    [children]
  );

  // A barcode is never reused, so a thaan cut before — or cut and cancelled —
  // continues the numbering rather than restarting it. The server allocates by
  // the same rule and has the last word.
  const firstSuffix = useMemo(() => {
    const used = (lineage.data ?? [])
      .filter(l => l.from_barcode === parent?.barcode)
      .map(l => Number(/-(\d+)$/.exec(l.to_barcode)?.[1] ?? 0));
    return Math.max(0, ...used) + 1;
  }, [lineage.data, parent?.barcode]);
  const held = Number(parent?.current_qty ?? 0);
  // Two decimals is what the column holds, so compare there and nowhere else.
  const left = Math.round((held - entered - (Number(lossQty) || 0)) * 100) / 100;
  const usable = children.filter(c => Number(c.qty) > 0);
  const ready = !!parent && (usable.length >= 2 || (usable.length >= 1 && Number(lossQty) > 0)) && left === 0;

  const find = async (e: React.FormEvent) => {
    e.preventDefault();
    const code = scan.trim();
    if (!code) return;
    setLooking(true);
    setLookupError(null);
    setNotice(null);
    clearError();
    try {
      const rows = await api.get<PieceRow[]>(`/pieces?barcode=${encodeURIComponent(code)}&limit=1`);
      const found = rows[0];
      if (!found) {
        setParent(null);
        setLookupError(`No piece carries the barcode ${code}`);
      } else if (!CUTTABLE.includes(found.status)) {
        setParent(null);
        setLookupError(
          `${code} is ${STATUS_LABEL[found.status] ?? found.status} — only goods in our own custody can be cut`
        );
      } else {
        setParent(found);
        setChildren([{ barcode: '', qty: '' }, { barcode: '', qty: '' }]);
      setLossQty('');
    setLossQty('');
      }
    } catch (err) {
      setLookupError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLooking(false);
    }
  };

  const setChild = (i: number, patch: Partial<Child>) =>
    setChildren(prev => prev.map((c, j) => (j === i ? { ...c, ...patch } : c)));

  const takeRest = (i: number) =>
    setChild(i, { qty: String(Math.round((left + (Number(children[i]?.qty) || 0)) * 100) / 100) });
  // @ts-ignore
  const takeLossRest = () => setLossQty(String(Math.round((left + (Number(lossQty) || 0)) * 100) / 100));

  const save = async () => {
    if (!ready) return;
    const out = await submit({
      entryDate,
      reason,
      lossQty: Number(lossQty) || 0,
      children: usable.map(c => ({
        ...(c.barcode.trim() ? { barcode: c.barcode.trim() } : {}),
        qty: Number(c.qty)
      }))
    });
    if (out?.pieces) {
      setNotice(
        `${out.entryNo}: ${out.from} cut into ${out.pieces.length} pieces — ` +
        out.pieces.map(p => `${p.barcode} (${p.qty})`).join(', ')
      );
      setParent(null);
      setScan('');
      setChildren([{ barcode: '', qty: '' }, { barcode: '', qty: '' }]);
    }
  };

  const reset = () => {
    setParent(null); setScan(''); setNotice(null); setLookupError(null); clearError();
    setChildren([{ barcode: '', qty: '' }, { barcode: '', qty: '' }]);
  };

  /**
   * Undoing a cut is a cancellation, not a deletion: the server reverses it
   * with fresh movements and refuses outright once any child has moved on.
   */
  const undo = async (regroupId: string, entryNo: string) => {
    const why = window.prompt(`Why is ${entryNo} being reversed?`);
    if (!why?.trim()) return;
    setLookupError(null);
    setNotice(null);
    try {
      await api.post(`/documents/piece_regroup/${regroupId}/cancel`, { reason: why.trim() });
      setNotice(`${entryNo} reversed — the pieces it created are retired and the thaan is back`);
      setParent(null);
      setScan('');
    } catch (err) {
      setLookupError(err instanceof ApiError ? err.message : String(err));
    }
  };

  return (
    <>
      <ToolbarRibbon
        title="Cut A Thaan Into Pieces"
        actions={[
          { key: 'save', onRun: save, disabled: !ready || busy,
            hint: !parent ? 'scan a barcode first'
                  : left !== 0 ? 'the pieces must add up to the whole thaan'
                  : (usable.length < 2 && !(usable.length === 1 && Number(lossQty) > 0)) ? 'a cut makes at least two pieces (or one and a loss)' : undefined },
          { key: 'reset', onRun: reset }
        ]}
      />

      <Banner error={error ?? lookupError} notice={notice} />

      <div className="p-3 flex-1 overflow-y-auto max-w-5xl mx-auto w-full space-y-3">
        <form onSubmit={find} className="bg-white rounded border border-[#b8c9dd] p-3
                                         flex flex-wrap items-center gap-2">
          <Scissors className="w-4 h-4 text-blue-700" />
          <label className="font-bold text-blue-900" htmlFor="cut-scan">Scan the thaan to cut</label>
          <input id="cut-scan" autoFocus value={scan} onChange={e => setScan(e.target.value)}
                 placeholder="scan or type, then Enter"
                 className="erp-input font-mono w-56 text-base py-2" />
          <button type="submit" className="erp-btn erp-btn-primary" disabled={looking}>
            {looking ? 'Looking…' : 'Find'}
          </button>
        </form>

        {parent && (
          <>
            <div className="bg-white rounded border border-[#b8c9dd] p-3
                            grid grid-cols-2 md:grid-cols-6 gap-3">
              <Field label="Barcode"><span className="font-mono text-blue-800">{parent.barcode}</span></Field>
              <Field label="Quality">{parent.quality}</Field>
              <Field label="Lot">{parent.lot_no || '—'}</Field>
              <Field label="State">{STATUS_LABEL[parent.status] ?? parent.status}</Field>
              <Field label="Length">
                <span className="font-mono">{held.toFixed(2)} {parent.uom ?? 'MTR'}</span>
              </Field>
              <Field label="Carries">
                <span className="font-mono">{money(Number(parent.cost ?? 0))}</span>
              </Field>
            </div>

            <div className="bg-white rounded border border-[#b8c9dd] overflow-hidden">
              <table className="w-full">
                <thead className="bg-slate-100 border-b border-slate-300 text-left">
                  <tr>
                    <th className="px-2 py-1.5 font-bold w-10">#</th>
                    <th className="px-2 py-1.5 font-bold">New barcode</th>
                    <th className="px-2 py-1.5 font-bold w-40 text-right">Length</th>
                    <th className="px-2 py-1.5 w-28"></th>
                  </tr>
                </thead>
                <tbody>
                  {children.map((c, i) => (
                    <tr key={i} className="border-b border-slate-100">
                      <td className="px-2 py-1">{i + 1}</td>
                      <td className="px-2 py-1">
                        <input value={c.barcode} onChange={e => setChild(i, { barcode: e.target.value })}
                               placeholder={`${parent.barcode}-${firstSuffix + i}`}
                               className="erp-input font-mono w-full" />
                      </td>
                      <td className="px-2 py-1">
                        <input type="number" step="0.01" min="0" inputMode="decimal"
                               value={c.qty} onChange={e => setChild(i, { qty: e.target.value })}
                               className="erp-input font-mono w-full text-right text-base py-2" />
                      </td>
                      <td className="px-2 py-1 text-right whitespace-nowrap">
                        {left > 0 && (
                          <button onClick={() => takeRest(i)} className="erp-btn py-0.5"
                                  title={`give this piece the remaining ${left.toFixed(2)}`}>
                            + rest
                          </button>
                        )}
                        {children.length > 2 && (
                          <button onClick={() => setChildren(p => p.filter((_, j) => j !== i))}
                                  className="erp-btn py-0.5 ml-1" title="remove">
                            <Trash2 className="w-3 h-3 text-red-600" />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                  <tr className="border-b border-slate-100 bg-red-50">
                    <td className="px-2 py-1"></td>
                    <td className="px-2 py-1 text-red-700 font-bold text-right pt-2">Cutting Loss (writes off value)</td>
                    <td className="px-2 py-1">
                      <input type="number" step="0.01" min="0" inputMode="decimal"
                             value={lossQty} onChange={e => setLossQty(e.target.value)}
                             placeholder="0.00"
                             className="erp-input font-mono w-full text-right text-red-900 border-red-200" />
                    </td>
                    <td className="px-2 py-1 text-left">
                      <button type="button" onClick={takeLossRest} className="text-red-700 hover:underline px-2 py-1 text-sm font-bold" title="Take remaining">+ rest</button>
                    </td>
                  </tr>
                </tbody>
                <tfoot>
                  <tr className={`font-bold ${left === 0 ? 'bg-emerald-50' : 'bg-amber-50'}`}>
                    <td className="px-2 py-2" colSpan={2}>
                      <button onClick={() => setChildren(p => [...p, { barcode: '', qty: '' }])}
                              className="erp-btn py-0.5">
                        <Plus className="w-3 h-3" /> Another piece
                      </button>
                    </td>
                    <td className="px-2 py-2 text-right font-mono">{entered.toFixed(2)}</td>
                    <td className="px-2 py-2 text-right whitespace-nowrap">
                      {left === 0
                        ? <span className="text-emerald-800">adds up</span>
                        : <span className="text-amber-800">{left.toFixed(2)} left</span>}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>

            {left < 0 && (
              <p className="text-red-700 font-semibold">
                The pieces are longer than the thaan. Nothing can be saved until they match.
              </p>
            )}
            {left > 0 && (
              <p className="text-amber-800">
                {left.toFixed(2)} {parent.uom ?? 'MTR'} is unaccounted for. Add the offcut as its own
                piece — a cutting loss must be written off where an accountant can see it, not
                buried in what is left.
              </p>
            )}

            <div className="bg-white rounded border border-[#b8c9dd] p-3 grid grid-cols-12 gap-2.5">
              <div className="col-span-4 md:col-span-3">
                <label className="erp-label block">Date</label>
                <input type="date" value={entryDate} onChange={e => setEntryDate(e.target.value)}
                       className="erp-input w-full" />
              </div>
              <div className="col-span-8 md:col-span-9">
                <label className="erp-label block">Why</label>
                <input value={reason} onChange={e => setReason(e.target.value)} maxLength={200}
                       placeholder="e.g. cut for Supreme's 40 metre order"
                       className="erp-input w-full" />
              </div>
            </div>

            <Lineage rows={lineage.data} loading={lineage.loading} error={lineage.error}
                     canUndo={MAY_UNDO.includes(session?.role ?? '')}
                     onUndo={undo} />
          </>
        )}

        {!parent && !lookupError && (
          <p className="text-slate-500 px-1">
            Scan any thaan in grey stock, back from dyeing, or packed. Goods lying at a process
            house cannot be cut — they are not in our hands.
          </p>
        )}
      </div>
    </>
  );
};

// ------------------------------------------------------------------- merge --

const MergePanel: React.FC = () => {
  const [scan, setScan] = useState('');
  const [picked, setPicked] = useState<PieceRow[]>([]);
  const [intoBarcode, setIntoBarcode] = useState('');
  const [entryDate, setEntryDate] = useState(today());
  const [reason, setReason] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);

  const { submit, busy, error, clearError } = useSubmit<unknown, MergeResult>('/pieces/merge');

  const first = picked[0];
  const qty = picked.reduce((sum, p) => sum + Number(p.current_qty), 0);
  const cost = picked.reduce((sum, p) => sum + Number(p.cost ?? 0), 0);
  const ready = picked.length >= 2 && intoBarcode.trim().length > 0;

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    const code = scan.trim();
    if (!code) return;
    setScan('');
    setPickError(null);
    setNotice(null);
    clearError();
    if (picked.some(p => p.barcode === code)) {
      setPickError(`${code} is already on the list`);
      return;
    }
    try {
      const rows = await api.get<PieceRow[]>(`/pieces?barcode=${encodeURIComponent(code)}&limit=1`);
      const found = rows[0];
      if (!found) return setPickError(`No piece carries the barcode ${code}`);
      if (!CUTTABLE.includes(found.status)) {
        return setPickError(
          `${code} is ${STATUS_LABEL[found.status] ?? found.status} and cannot be joined`
        );
      }
      // The server refuses a mismatch anyway; saying so here saves a round trip
      // and, on the floor, a wasted walk back to the rack.
      if (first && (found.quality !== first.quality || found.lot_no !== first.lot_no
                    || found.grade_code !== first.grade_code || found.status !== first.status)) {
        return setPickError(
          `${code} is ${found.quality} / lot ${found.lot_no || '—'} / grade ${found.grade_code}` +
          ` — it will not join ${first.quality} / lot ${first.lot_no || '—'} / grade ${first.grade_code}`
        );
      }
      setPicked(prev => [...prev, found]);
    } catch (err) {
      setPickError(err instanceof ApiError ? err.message : String(err));
    }
  };

  const save = async () => {
    if (!ready) return;
    const out = await submit({
      barcodes: picked.map(p => p.barcode),
      intoBarcode: intoBarcode.trim(),
      entryDate,
      reason
    });
    if (out?.from) {
      setNotice(`${out.entryNo}: ${out.from.length} pieces are now ${out.into} — ${out.qty} in one roll`);
      setPicked([]);
      setIntoBarcode('');
    }
  };

  return (
    <>
      <ToolbarRibbon
        title="Join Short Ends Into One Piece"
        actions={[
          { key: 'save', onRun: save, disabled: !ready || busy,
            hint: picked.length < 2 ? 'scan at least two pieces'
                  : !intoBarcode.trim() ? 'the joined roll needs a new barcode' : undefined },
          { key: 'reset', onRun: () => { setPicked([]); setIntoBarcode(''); setNotice(null); setPickError(null); clearError(); } }
        ]}
      />

      <Banner error={error ?? pickError} notice={notice} />

      <div className="p-3 flex-1 overflow-y-auto max-w-5xl mx-auto w-full space-y-3">
        <form onSubmit={add} className="bg-white rounded border border-[#b8c9dd] p-3
                                        flex flex-wrap items-center gap-2">
          <Merge className="w-4 h-4 text-blue-700" />
          <label className="font-bold text-blue-900" htmlFor="merge-scan">Scan each short end</label>
          <input id="merge-scan" autoFocus value={scan} onChange={e => setScan(e.target.value)}
                 placeholder="scan or type, then Enter"
                 className="erp-input font-mono w-56 text-base py-2" />
          {first && (
            <span className="text-slate-500">
              joining {first.quality} · lot {first.lot_no || '—'} · grade {first.grade_code}
            </span>
          )}
        </form>

        <div className="bg-white rounded border border-[#b8c9dd] overflow-hidden">
          <table className="w-full">
            <thead className="bg-slate-100 border-b border-slate-300 text-left">
              <tr>
                <th className="px-2 py-1.5 font-bold w-10">#</th>
                <th className="px-2 py-1.5 font-bold">Barcode</th>
                <th className="px-2 py-1.5 font-bold">Quality</th>
                <th className="px-2 py-1.5 font-bold text-right">Length</th>
                <th className="px-2 py-1.5 font-bold text-right">Carries</th>
                <th className="px-2 py-1.5 w-10"></th>
              </tr>
            </thead>
            <tbody>
              {picked.length === 0 && (
                <tr><td colSpan={6} className="px-2 py-6 text-center text-slate-400">
                  Scan two or more pieces of the same quality, design, grade and lot
                </td></tr>
              )}
              {picked.map((p, i) => (
                <tr key={p.barcode} className="border-b border-slate-100">
                  <td className="px-2 py-1">{i + 1}</td>
                  <td className="px-2 py-1 font-mono text-blue-800">{p.barcode}</td>
                  <td className="px-2 py-1">{p.quality}</td>
                  <td className="px-2 py-1 text-right font-mono">{Number(p.current_qty).toFixed(2)}</td>
                  <td className="px-2 py-1 text-right font-mono">{money(Number(p.cost ?? 0))}</td>
                  <td className="px-2 py-1 text-right">
                    <button onClick={() => setPicked(prev => prev.filter((_, j) => j !== i))}
                            className="erp-btn py-0.5" title="remove">
                      <Trash2 className="w-3 h-3 text-red-600" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
            {picked.length > 0 && (
              <tfoot>
                <tr className="bg-slate-50 font-bold">
                  <td className="px-2 py-2" colSpan={3}>{picked.length} pieces</td>
                  <td className="px-2 py-2 text-right font-mono">{qty.toFixed(2)}</td>
                  <td className="px-2 py-2 text-right font-mono">{money(cost)}</td>
                  <td></td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>

        <div className="bg-white rounded border border-[#b8c9dd] p-3 grid grid-cols-12 gap-2.5">
          <div className="col-span-12 md:col-span-4">
            <label className="erp-label block text-red-700 font-bold">* Barcode for the joined roll</label>
            <input value={intoBarcode} onChange={e => setIntoBarcode(e.target.value)} maxLength={40}
                   placeholder="print a fresh label" className="erp-input w-full font-mono" />
          </div>
          <div className="col-span-4 md:col-span-2">
            <label className="erp-label block">Date</label>
            <input type="date" value={entryDate} onChange={e => setEntryDate(e.target.value)}
                   className="erp-input w-full" />
          </div>
          <div className="col-span-8 md:col-span-6">
            <label className="erp-label block">Why</label>
            <input value={reason} onChange={e => setReason(e.target.value)} maxLength={200}
                   placeholder="e.g. re-lotting short ends" className="erp-input w-full" />
          </div>
        </div>
      </div>
    </>
  );
};

// ------------------------------------------------------------------ shared --

const Banner: React.FC<{ error: string | null; notice: string | null }> = ({ error, notice }) =>
  error || notice ? (
    <div className={`px-4 py-1.5 flex items-center gap-2 font-semibold ${
      error ? 'bg-red-600 text-white' : 'bg-emerald-600 text-white'
    }`}>
      {error ? <AlertTriangle className="w-4 h-4 shrink-0" /> : <CheckCircle2 className="w-4 h-4 shrink-0" />}
      <span>{error ?? notice}</span>
    </div>
  ) : null;

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div>
    <span className="erp-label block">{label}</span>
    <span className="font-semibold">{children}</span>
  </div>
);

const Lineage: React.FC<{
  rows: LineageRow[] | null; loading: boolean; error: string | null;
  canUndo: boolean; onUndo: (regroupId: string, entryNo: string) => void;
}> = ({ rows, loading, error, canUndo, onUndo }) => {
  if (loading) return <p className="text-slate-500 px-1">Loading history…</p>;
  if (error) return <p className="text-red-700 px-1">{error}</p>;
  if (!rows || rows.length === 0) return null;
  // One row per child; the undo belongs to the entry, so offer it once each.
  const firstOf = new Map<string, LineageRow>();
  for (const r of rows) if (!firstOf.has(r.regroup_id)) firstOf.set(r.regroup_id, r);
  return (
    <div className="bg-white rounded border border-[#b8c9dd] overflow-hidden">
      <div className="bg-slate-100 border-b border-slate-300 px-2 py-1.5 font-bold">
        This barcode has been regrouped before
      </div>
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="border-b border-slate-200 text-left text-slate-600">
            <tr>
              <th className="px-2 py-1">Entry</th><th className="px-2 py-1">Date</th>
              <th className="px-2 py-1">What</th><th className="px-2 py-1">From</th>
              <th className="px-2 py-1">To</th><th className="px-2 py-1 text-right">Qty</th>
              <th className="px-2 py-1">Why</th><th className="px-2 py-1"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className={`border-b border-slate-100 ${
                r.doc_status === 'cancelled' ? 'text-slate-400 line-through' : ''
              }`}>
                <td className="px-2 py-1 font-mono">{r.entry_no}</td>
                <td className="px-2 py-1">{r.entry_date}</td>
                <td className="px-2 py-1">{r.kind}</td>
                <td className="px-2 py-1 font-mono text-blue-800">{r.from_barcode}</td>
                <td className="px-2 py-1 font-mono text-blue-800">{r.to_barcode}</td>
                <td className="px-2 py-1 text-right font-mono">{Number(r.qty).toFixed(2)}</td>
                <td className="px-2 py-1 text-slate-600">{r.reason}</td>
                <td className="px-2 py-1 text-right no-underline">
                  {canUndo && r.doc_status !== 'cancelled'
                    && firstOf.get(r.regroup_id) === r && (
                    <button onClick={() => onUndo(r.regroup_id, r.entry_no)}
                            className="erp-btn py-0.5"
                            title="reverse this entry — refused once a piece has moved on">
                      <Undo2 className="w-3 h-3 text-red-600" /> Undo
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};
