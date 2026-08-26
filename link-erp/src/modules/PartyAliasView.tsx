import React, { useState } from 'react';
import { ToolbarRibbon } from '../components/ToolbarRibbon';
import { useApi } from '../lib/useApi';
import { api, ApiError, type LedgerRow, type QualityRow, type DesignRow } from '../lib/api';
import { AlertTriangle, CheckCircle2, Languages, Trash2 } from 'lucide-react';

/**
 * What each customer calls our cloth.
 *
 * A trader sells the same Galaxy to three mills under three names. A challan
 * that prints ours makes their storekeeper reconcile it by hand, every time,
 * and every hand-reconciliation is a future dispute. The alias is printed on
 * their packing list and invoice; our own name stays on the row beside it, for
 * our own people.
 */

interface AliasRow {
  id: string; party_id: string; party: string;
  quality_id: string; quality: string;
  design_id: string | null; design: string | null;
  their_quality: string; their_design: string; notes: string;
}

export const PartyAliasView: React.FC = () => {
  const [partyId, setPartyId] = useState('');
  const [qualityId, setQualityId] = useState('');
  const [designId, setDesignId] = useState('');
  const [theirQuality, setTheirQuality] = useState('');
  const [theirDesign, setTheirDesign] = useState('');
  const [notes, setNotes] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const aliases = useApi<AliasRow[]>('/party-aliases');
  const ledgers = useApi<LedgerRow[]>('/ledgers');
  const qualities = useApi<QualityRow[]>('/qualities');
  const designs = useApi<DesignRow[]>('/designs');

  const designsForQuality = (designs.data ?? []).filter(d => d.quality_id === qualityId);
  const ready = !!partyId && !!qualityId && (theirQuality.trim() || theirDesign.trim());

  const save = async () => {
    setError(null);
    try {
      await api.post('/party-aliases', {
        partyId, qualityId, designId: designId || null,
        theirQuality: theirQuality.trim(), theirDesign: theirDesign.trim(), notes: notes.trim()
      });
      setNotice('Saved. Their challan and invoice will print this name.');
      setTheirQuality(''); setTheirDesign(''); setNotes('');
      aliases.reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  };

  const remove = async (row: AliasRow) => {
    if (!window.confirm(
      `Stop printing "${row.their_quality || row.their_design}" for ${row.party}?\n\n` +
      `Their documents will go back to our own name, ${row.quality}.`
    )) return;
    try {
      await api.del(`/party-aliases/${row.id}`);
      setNotice('Removed; our own name will be printed again.');
      aliases.reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  };

  return (
    <div className="flex flex-col h-full bg-[#ecf1f7] text-slate-800 text-xs">
      <ToolbarRibbon
        title="Customer Names For Our Cloth"
        actions={[
          { key: 'save', onRun: save, disabled: !ready,
            hint: !partyId ? 'pick a customer'
                  : !qualityId ? 'pick a quality'
                  : 'give their name for the quality, the design, or both' },
          { key: 'reset', onRun: () => aliases.reload() }
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

      <div className="p-3 flex-1 overflow-y-auto max-w-6xl mx-auto w-full space-y-3">
        <div className="bg-white rounded border border-[#b8c9dd] p-3 space-y-2">
          <div className="font-bold text-blue-900 flex items-center gap-1.5">
            <Languages className="w-4 h-4" /> Add a customer's name
          </div>

          <div className="grid grid-cols-12 gap-2.5">
            <div className="col-span-12 md:col-span-3">
              <label className="erp-label block" htmlFor="alias-party">Customer</label>
              <select id="alias-party" value={partyId} onChange={e => setPartyId(e.target.value)}
                      className="erp-input w-full">
                <option value="">— select —</option>
                {(ledgers.data ?? []).map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </div>
            <div className="col-span-6 md:col-span-2">
              <label className="erp-label block" htmlFor="alias-quality">Our quality</label>
              <select id="alias-quality" value={qualityId}
                      onChange={e => { setQualityId(e.target.value); setDesignId(''); }}
                      className="erp-input w-full">
                <option value="">— select —</option>
                {(qualities.data ?? []).map(q => <option key={q.id} value={q.id}>{q.name}</option>)}
              </select>
            </div>
            <div className="col-span-6 md:col-span-2">
              <label className="erp-label block" htmlFor="alias-design">Our design</label>
              <select id="alias-design" value={designId} onChange={e => setDesignId(e.target.value)}
                      className="erp-input w-full" disabled={!qualityId}>
                <option value="">whole quality</option>
                {designsForQuality.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </div>
            <div className="col-span-6 md:col-span-2">
              <label className="erp-label block" htmlFor="alias-their-quality">They call it</label>
              <input id="alias-their-quality" value={theirQuality} maxLength={120}
                     onChange={e => setTheirQuality(e.target.value)}
                     placeholder="their quality name" className="erp-input w-full" />
            </div>
            <div className="col-span-6 md:col-span-2">
              <label className="erp-label block" htmlFor="alias-their-design">Their design name</label>
              <input id="alias-their-design" value={theirDesign} maxLength={120}
                     onChange={e => setTheirDesign(e.target.value)}
                     className="erp-input w-full" />
            </div>
            <div className="col-span-12 md:col-span-1">
              <label className="erp-label block" htmlFor="alias-notes">Note</label>
              <input id="alias-notes" value={notes} maxLength={200}
                     onChange={e => setNotes(e.target.value)} className="erp-input w-full" />
            </div>
          </div>

          <p className="text-slate-500">
            A design-specific name wins over one set for the whole quality. Saving the same
            customer and cloth twice replaces the earlier answer rather than adding a second.
          </p>
        </div>

        <div className="bg-white rounded border border-[#b8c9dd] overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-slate-100 border-b border-slate-300 text-left">
                <tr>
                  <th className="px-2 py-1.5 font-bold">Customer</th>
                  <th className="px-2 py-1.5 font-bold">Our name</th>
                  <th className="px-2 py-1.5 font-bold">Their name</th>
                  <th className="px-2 py-1.5 font-bold">Note</th>
                  <th className="px-2 py-1.5 w-12"></th>
                </tr>
              </thead>
              <tbody>
                {aliases.loading && (
                  <tr><td colSpan={5} className="px-2 py-6 text-center text-slate-400">Loading…</td></tr>
                )}
                {!aliases.loading && (aliases.data ?? []).length === 0 && (
                  <tr><td colSpan={5} className="px-2 py-6 text-center text-slate-400">
                    No customer has given us their own name yet; every document prints ours.
                  </td></tr>
                )}
                {(aliases.data ?? []).map(row => (
                  <tr key={row.id} className="border-b border-slate-100">
                    <td className="px-2 py-1.5 font-semibold">{row.party}</td>
                    <td className="px-2 py-1.5">
                      {row.quality}{row.design ? ` · ${row.design}` : ''}
                    </td>
                    <td className="px-2 py-1.5 font-semibold text-blue-900">
                      {row.their_quality || '—'}
                      {row.their_design ? ` · ${row.their_design}` : ''}
                    </td>
                    <td className="px-2 py-1.5 text-slate-600">{row.notes}</td>
                    <td className="px-2 py-1.5 text-right">
                      <button onClick={() => remove(row)} aria-label={`Remove alias for ${row.party}`}
                              className="erp-btn py-0.5">
                        <Trash2 className="w-3 h-3 text-red-600" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
};
