import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from './api';

interface State<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
}

interface CacheEntry { data: unknown; storedAt: number }
const CACHE_TTL_MS = 30_000;
const responseCache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<unknown>>();
let cacheEpoch = 0;

export function clearApiCache(path?: string): void {
  cacheEpoch += 1;
  if (path) responseCache.delete(path);
  else responseCache.clear();
  // A request already on the wire cannot be cancelled reliably, but it must
  // not repopulate a cache that a financial write, sign-out, or test reset
  // deliberately invalidated.
  if (path) inFlight.delete(path);
  else inFlight.clear();
}

function cachedGet<T>(path: string): Promise<T> {
  const running = inFlight.get(path) as Promise<T> | undefined;
  if (running) return running;
  const requestEpoch = cacheEpoch;
  const request = api.get<T>(path)
    .then(data => {
      if (requestEpoch === cacheEpoch) responseCache.set(path, { data, storedAt: Date.now() });
      return data;
    })
    .finally(() => {
      if (inFlight.get(path) === request) inFlight.delete(path);
    });
  inFlight.set(path, request);
  return request;
}

/** GET with reload. `deps` re-fetches; `reload` re-fetches after a write. */
export function useApi<T>(path: string | null, deps: unknown[] = []) {
  const [state, setState] = useState<State<T>>({ data: null, error: null, loading: !!path });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!path) {
      setState({ data: null, error: null, loading: false });
      return;
    }
    let live = true;
    const cached = responseCache.get(path);
    const fresh = cached && Date.now() - cached.storedAt <= CACHE_TTL_MS;
    if (fresh) setState({ data: cached.data as T, error: null, loading: false });
    else setState(s => ({ ...s, loading: true }));

    // Stale-while-revalidate: switching between ERP documents is immediate,
    // while the server remains the authority and refreshes in the background.
    cachedGet<T>(path)
      .then(data => { if (live) setState({ data, error: null, loading: false }); })
      .catch((e: ApiError) => {
        if (live) setState({ data: fresh ? cached.data as T : null, error: e.message, loading: false });
      });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, tick, ...deps]);

  useEffect(() => {
    const refresh = () => setTick(t => t + 1);
    window.addEventListener('focus', refresh);
    window.addEventListener('online', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      window.removeEventListener('online', refresh);
    };
  }, []);

  const reload = useCallback(() => {
    if (path) clearApiCache(path);
    setTick(t => t + 1);
  }, [path]);
  return { ...state, reload };
}

/** POST with in-flight and error state, so screens do not each re-invent it. */
export function useSubmit<TIn, TOut>(path: string) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(async (body: TIn): Promise<TOut | null> => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<TOut>(path, body);
      // Financial writes can affect stock, ledgers, approvals and dashboard
      // totals at once. Clearing a small in-memory cache is safer than trying
      // to guess every dependent query or showing optimistic accounting.
      clearApiCache();
      return result;
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      return null;
    } finally {
      setBusy(false);
    }
  }, [path]);

  return { submit, busy, error, clearError: () => setError(null) };
}
