import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import { clearApiCache } from '../lib/useApi';

/**
 * Async assertions get five seconds rather than one.
 *
 * These suites mount large stateful screens in jsdom, several files at a time.
 * Under that contention a `waitFor` can expire while the assertion is on its
 * way to becoming true, which fails a correct test on a busy machine and
 * passes it on an idle one. The assertion still has to hold; it is only given
 * room to. A test that needs more than five seconds is a real defect.
 */
configure({ asyncUtilTimeout: 5000 });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  globalThis.localStorage?.clear();
  clearApiCache();
});

/** Node 26 exposes localStorage through a warning-producing getter unless a
 * file is configured. Never touch that getter: tests receive a deterministic,
 * in-memory browser store unconditionally. */
const store = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() { return store.size; }
  }
});

// jsdom implements neither, and both are load-bearing: the CSV export builds a
// blob URL and several screens call window.print().
if (!URL.createObjectURL) {
  URL.createObjectURL = vi.fn(() => 'blob:test');
  URL.revokeObjectURL = vi.fn();
}
window.print = vi.fn();
// A CSV download intentionally clicks a detached anchor. jsdom otherwise
// schedules a navigation it cannot implement and emits a false error after a
// passing test.
HTMLAnchorElement.prototype.click = vi.fn();
