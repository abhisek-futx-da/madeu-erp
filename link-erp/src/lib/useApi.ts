import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from './api';

interface State<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
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
    setState(s => ({ ...s, loading: true }));
    api.get<T>(path)
      .then(data => { if (live) setState({ data, error: null, loading: false }); })
      .catch((e: ApiError) => { if (live) setState({ data: null, error: e.message, loading: false }); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, tick, ...deps]);

  const reload = useCallback(() => setTick(t => t + 1), []);
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
      return await api.post<TOut>(path, body);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      return null;
    } finally {
      setBusy(false);
    }
  }, [path]);

  return { submit, busy, error, clearError: () => setError(null) };
}
