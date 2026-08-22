import { describe, test, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { usePagedList } from './usePagedList';

/**
 * Paging, search and export are the controls that make a list of ten thousand
 * dispatches usable. Before this hook every screen showed whatever the first
 * 200 rows happened to be.
 */

const seen: string[] = [];

function mockApi(total: number) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    seen.push(String(url));
    const u = new URL(String(url), 'http://x');
    const limit = Number(u.searchParams.get('limit') ?? 50);
    const offset = Number(u.searchParams.get('offset') ?? 0);
    const matching = u.searchParams.get('q') ? Math.min(total, 3) : total;
    const rows = Array.from(
      { length: Math.max(0, Math.min(limit, matching - offset)) },
      (_, i) => ({ id: `row-${offset + i}` })
    );
    return {
      ok: true, status: 200,
      headers: new Headers(),
      text: async () => JSON.stringify({ rows, total: matching, limit, offset })
    } as unknown as Response;
  }));
}

beforeEach(() => { seen.length = 0; });

describe('usePagedList', () => {
  test('asks for the first page and reports the true total', async () => {
    mockApi(137);
    const { result } = renderHook(() => usePagedList<{ id: string }>('/dispatches', 50));
    await waitFor(() => expect(result.current.rows.length).toBe(50));
    expect(result.current.total).toBe(137);
    expect(result.current.hasNext).toBe(true);
    expect(result.current.hasPrev).toBe(false);
  });

  test('reaches rows past the old hard limit of 200', async () => {
    mockApi(1000);
    const { result } = renderHook(() => usePagedList<{ id: string }>('/dispatches', 50));
    await waitFor(() => expect(result.current.rows.length).toBe(50));

    for (let i = 0; i < 5; i++) act(() => result.current.next());
    await waitFor(() => expect(result.current.offset).toBe(250));
    await waitFor(() => expect(result.current.rows[0]?.id).toBe('row-250'));
  });

  test('does not page past the end', async () => {
    mockApi(60);
    const { result } = renderHook(() => usePagedList<{ id: string }>('/payments', 50));
    await waitFor(() => expect(result.current.total).toBe(60));
    act(() => result.current.next());
    await waitFor(() => expect(result.current.offset).toBe(50));
    act(() => result.current.next());
    expect(result.current.offset).toBe(50);
  });

  test('a new search starts again at the first page', async () => {
    mockApi(500);
    const { result } = renderHook(() => usePagedList<{ id: string }>('/sales-invoices', 50));
    await waitFor(() => expect(result.current.rows.length).toBe(50));

    act(() => result.current.next());
    await waitFor(() => expect(result.current.offset).toBe(50));

    act(() => result.current.search('Supreme'));
    await waitFor(() => expect(result.current.offset).toBe(0));
    await waitFor(() => expect(result.current.total).toBe(3));
    expect(seen.at(-1)).toContain('q=Supreme');
  });

  test('date filters reach the query string', async () => {
    mockApi(10);
    const { result } = renderHook(() => usePagedList('/sales-invoices', 50));
    await waitFor(() => expect(result.current.total).toBe(10));

    act(() => result.current.setFromDate('2026-04-01'));
    act(() => result.current.setToDate('2026-09-30'));
    await waitFor(() => expect(seen.at(-1)).toContain('from=2026-04-01'));
    expect(seen.at(-1)).toContain('to=2026-09-30');
    expect(result.current.filtered).toBe(true);
  });

  test('clear removes every filter', async () => {
    mockApi(10);
    const { result } = renderHook(() => usePagedList('/gst-notes', 50));
    await waitFor(() => expect(result.current.total).toBe(10));
    act(() => result.current.search('x'));
    await waitFor(() => expect(result.current.filtered).toBe(true));
    act(() => result.current.clear());
    await waitFor(() => expect(result.current.filtered).toBe(false));
  });

  test('export asks for csv and drops the page window', async () => {
    mockApi(500);
    const { result } = renderHook(() => usePagedList('/payments', 50));
    await waitFor(() => expect(result.current.total).toBe(500));

    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      seen.push(String(url));
      return {
        ok: true, status: 200,
        headers: new Headers({ 'content-disposition': 'attachment; filename="payments.csv"' }),
        blob: async () => new Blob(['a,b'])
      } as unknown as Response;
    }));
    await act(() => result.current.exportCsv());

    const asked = seen.at(-1)!;
    expect(asked).toContain('format=csv');
    expect(asked).not.toContain('limit=');
    expect(asked).not.toContain('offset=');
  });
});
