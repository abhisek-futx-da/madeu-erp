import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  globalThis.localStorage?.clear();
});

/**
 * Node 26 defines its own `localStorage` global, undefined unless the process
 * was started with --localstorage-file, and it shadows jsdom's. Without this
 * every module that reads a token throws before the test begins.
 */
if (!globalThis.localStorage?.getItem) {
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
}

// jsdom implements neither, and both are load-bearing: the CSV export builds a
// blob URL and several screens call window.print().
if (!URL.createObjectURL) {
  URL.createObjectURL = vi.fn(() => 'blob:test');
  URL.revokeObjectURL = vi.fn();
}
window.print = vi.fn();
