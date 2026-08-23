import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import { clearApiCache } from '../lib/useApi';

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
