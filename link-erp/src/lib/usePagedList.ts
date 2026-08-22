import { useCallback, useMemo, useState } from 'react';
import { api, type Page } from './api';
import { useApi } from './useApi';

/**
 * Search, date range, paging and CSV export for a document list. Every screen
 * used to render whatever the first 200 rows happened to be, with no filter
 * and no way past them.
 */
export function usePagedList<T>(basePath: string, pageSize = 50) {
  const [q, setQ] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [offset, setOffset] = useState(0);

  const query = useMemo(() => {
    const p = new URLSearchParams();
    if (q.trim()) p.set('q', q.trim());
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    p.set('limit', String(pageSize));
    p.set('offset', String(offset));
    return p;
  }, [q, from, to, offset, pageSize]);

  const sep = basePath.includes('?') ? '&' : '?';
  const { data, error, loading, reload } = useApi<Page<T>>(`${basePath}${sep}${query}`);

  // Any change to what is being asked for starts again at the first page.
  const search = useCallback((v: string) => { setQ(v); setOffset(0); }, []);
  const setFromDate = useCallback((v: string) => { setFrom(v); setOffset(0); }, []);
  const setToDate = useCallback((v: string) => { setTo(v); setOffset(0); }, []);
  const clear = useCallback(() => { setQ(''); setFrom(''); setTo(''); setOffset(0); }, []);

  const exportCsv = useCallback(() => {
    const p = new URLSearchParams(query);
    p.set('format', 'csv');
    p.delete('limit');
    p.delete('offset');
    return api.download(`${basePath}${sep}${p}`, basePath.replace(/\W+/g, '-'));
  }, [basePath, query, sep]);

  const total = data?.total ?? 0;
  return {
    rows: data?.rows ?? [],
    total, loading, error, reload,
    q, from, to, offset, pageSize,
    search, setFromDate, setToDate, clear, exportCsv,
    filtered: Boolean(q || from || to),
    next: () => setOffset(o => (o + pageSize < total ? o + pageSize : o)),
    prev: () => setOffset(o => Math.max(0, o - pageSize)),
    hasNext: offset + pageSize < total,
    hasPrev: offset > 0
  };
}

export type PagedList<T> = ReturnType<typeof usePagedList<T>>;
