import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { api } from './api';
import { clearApiCache, useApi } from './useApi';

describe('useApi server-state cache', () => {
  it('deduplicates simultaneous reads of the same ERP resource', async () => {
    let release!: (value: { rows: number[] }) => void;
    const pending = new Promise<{ rows: number[] }>(resolve => { release = resolve; });
    const get = vi.spyOn(api, 'get').mockReturnValue(pending);
    const first = renderHook(() => useApi<{ rows: number[] }>('/shared'));
    const second = renderHook(() => useApi<{ rows: number[] }>('/shared'));

    expect(get).toHaveBeenCalledTimes(1);
    release({ rows: [1] });
    await waitFor(() => expect(first.result.current.data).toEqual({ rows: [1] }));
    expect(second.result.current.data).toEqual({ rows: [1] });
  });

  it('serves a recent result immediately and still revalidates it', async () => {
    const get = vi.spyOn(api, 'get')
      .mockResolvedValueOnce({ value: 'first' })
      .mockResolvedValueOnce({ value: 'fresh' });
    const initial = renderHook(() => useApi<{ value: string }>('/cached'));
    await waitFor(() => expect(initial.result.current.data?.value).toBe('first'));
    initial.unmount();

    const reopened = renderHook(() => useApi<{ value: string }>('/cached'));
    expect(reopened.result.current.data?.value).toBe('first');
    await waitFor(() => expect(reopened.result.current.data?.value).toBe('fresh'));
    expect(get).toHaveBeenCalledTimes(2);
    clearApiCache('/cached');
  });
});
