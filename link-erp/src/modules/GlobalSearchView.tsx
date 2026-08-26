import React, { useState } from 'react';
import { ArrowRight, Search } from 'lucide-react';
import { ToolbarRibbon } from '../components/ToolbarRibbon';
import { useApi } from '../lib/useApi';

interface SearchResult {
  kind: string; id: string; title: string; subtitle: string; module: string;
  filter: string; status: string | null; occurred_on: string | null;
}

const KIND: Record<string, string> = {
  piece: 'Barcode / piece', ledger: 'Ledger', purchase_order: 'Purchase order',
  sales_order: 'Sales order', dispatch: 'Delivery challan', sales_invoice: 'Sales invoice',
  purchase_invoice: 'Purchase invoice', payment: 'Receipt / payment', gst_note: 'GST note',
  eway_bill: 'E-way bill'
};

export const GlobalSearchView: React.FC<{
  onOpen: (module: string, query?: string) => void;
}> = ({ onOpen }) => {
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  const search = useApi<SearchResult[]>(query.length >= 2
    ? `/global-search?q=${encodeURIComponent(query)}` : null, [query]);
  const rows = search.data ?? [];

  return (
    <div className="flex flex-col h-full bg-[#ecf1f7] text-slate-800 text-xs">
      <ToolbarRibbon title="Global Operational Search" />
      <form onSubmit={event => { event.preventDefault(); setQuery(input.trim()); }} className="p-4 bg-white border-b border-slate-200 flex items-center gap-2">
        <Search className="w-5 h-5 text-blue-800" />
        <label htmlFor="global-search" className="font-bold text-blue-950">Find anything</label>
        <input id="global-search" autoFocus value={input} onChange={event => setInput(event.target.value)} className="erp-input w-full max-w-2xl" placeholder="Barcode, party, GSTIN, order, invoice, payment, e-way bill or edition document…" />
        <button type="submit" disabled={input.trim().length < 2} className="erp-btn erp-btn-primary font-bold disabled:opacity-40">Search</button>
      </form>
      <div className="flex-1 overflow-auto p-4">
        {!query && <div className="max-w-3xl mx-auto mt-12 text-center text-slate-500"><Search className="w-10 h-10 mx-auto text-slate-300 mb-3" /><p className="font-semibold">Search across this company’s operational records from one place.</p><p className="mt-1">Results never cross tenant boundaries.</p></div>}
        {query && search.loading && <p className="text-center p-8 text-slate-500">Searching…</p>}
        {query && !search.loading && rows.length === 0 && <p className="text-center p-8 text-slate-500">No record matches “{query}”.</p>}
        <div className="max-w-5xl mx-auto space-y-2">
          {rows.map(row => <button key={`${row.kind}-${row.id}`} type="button" onClick={() => onOpen(row.module, row.filter)} className="w-full bg-white border border-[#b8c9dd] rounded p-3 text-left hover:border-blue-500 hover:bg-blue-50 flex items-center gap-3 group">
            <div className="min-w-32"><span className="inline-block rounded bg-blue-100 text-blue-900 px-2 py-0.5 font-bold">{KIND[row.kind] ?? row.kind}</span></div>
            <div className="min-w-0 flex-1"><div className="font-bold text-sm text-slate-900 truncate">{row.title}</div><div className="text-slate-600 truncate">{row.subtitle || '—'}</div></div>
            {row.status && <span className="uppercase text-[10px] font-bold text-slate-500">{row.status}</span>}
            <span className="text-blue-800 font-semibold flex items-center gap-1">Open <ArrowRight className="w-4 h-4 group-hover:translate-x-0.5" /></span>
          </button>)}
        </div>
      </div>
    </div>
  );
};
