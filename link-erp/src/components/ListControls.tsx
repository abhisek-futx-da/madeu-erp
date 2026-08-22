
import { Search, X, ChevronLeft, ChevronRight, Download } from 'lucide-react';
import type { PagedList } from '../lib/usePagedList';

/** The search / date-range / paging / export bar every document list wears. */
export function ListControls<T>({
  list, placeholder = 'Search…'
}: { list: PagedList<T>; placeholder?: string }) {
  const first = list.total === 0 ? 0 : list.offset + 1;
  const last = Math.min(list.offset + list.pageSize, list.total);

  return (
    <div className="flex flex-wrap items-center gap-2 px-3 py-2 bg-slate-50 border-b border-slate-200 text-xs print:hidden">
      <div className="relative">
        <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
        <input
          value={list.q}
          onChange={e => list.search(e.target.value)}
          placeholder={placeholder}
          className="pl-7 pr-2 py-1 border border-slate-300 rounded w-56 focus:outline-hidden focus:ring-1 focus:ring-blue-500"
        />
      </div>

      <label className="flex items-center gap-1 text-slate-600">
        From
        <input type="date" value={list.from} onChange={e => list.setFromDate(e.target.value)}
          className="border border-slate-300 rounded px-1 py-1" />
      </label>
      <label className="flex items-center gap-1 text-slate-600">
        To
        <input type="date" value={list.to} onChange={e => list.setToDate(e.target.value)}
          className="border border-slate-300 rounded px-1 py-1" />
      </label>

      {list.filtered && (
        <button onClick={list.clear} type="button"
          className="flex items-center gap-1 text-slate-600 hover:text-slate-900">
          <X className="w-3.5 h-3.5" /> Clear
        </button>
      )}

      <div className="ml-auto flex items-center gap-2">
        <span className="text-slate-600 tabular-nums">
          {list.total === 0 ? 'No records' : `${first}–${last} of ${list.total}`}
        </span>
        <button type="button" onClick={list.prev} disabled={!list.hasPrev}
          title="Previous page"
          className="erp-btn disabled:opacity-30 disabled:cursor-not-allowed">
          <ChevronLeft className="w-3.5 h-3.5" />
        </button>
        <button type="button" onClick={list.next} disabled={!list.hasNext}
          title="Next page"
          className="erp-btn disabled:opacity-30 disabled:cursor-not-allowed">
          <ChevronRight className="w-3.5 h-3.5" />
        </button>
        <button type="button" onClick={() => void list.exportCsv()}
          title="Download these rows as CSV (Ctrl+E)"
          className="erp-btn text-slate-700">
          <Download className="w-3.5 h-3.5" /> Export
        </button>
      </div>
    </div>
  );
}
