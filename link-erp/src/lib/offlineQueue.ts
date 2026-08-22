import { api, ApiError } from './api';

/**
 * Offline queue for godown-floor scanning. Signal in a warehouse is bad and a
 * scan that is lost because the wifi dropped is a piece that silently vanishes
 * from the trail. Scans are written to IndexedDB first and flushed when the
 * network returns; the queue survives a reload and a closed laptop.
 */

const DB_NAME = 'link-erp-offline';
const STORE = 'queued';
const VERSION = 1;

export interface QueuedScan {
  id: string;
  path: string;
  body: unknown;
  queuedAt: number;
  attempts: number;
  lastError?: string;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const enqueue = async (path: string, body: unknown): Promise<QueuedScan> => {
  const item: QueuedScan = {
    id: crypto.randomUUID(), path, body, queuedAt: Date.now(), attempts: 0
  };
  await tx('readwrite', s => s.add(item));
  return item;
};

export const pending = () => tx<QueuedScan[]>('readonly', s => s.getAll());
export const forget = (id: string) => tx('readwrite', s => s.delete(id));

const update = async (item: QueuedScan) => tx('readwrite', s => s.put(item));

export interface FlushResult {
  sent: number;
  failed: number;
  rejected: QueuedScan[];
}

/**
 * Sends everything queued, oldest first. A 4xx means the server has judged the
 * document and retrying will not help, so it is surfaced for a human rather
 * than looped on forever; anything else stays queued.
 */
export async function flush(): Promise<FlushResult> {
  const items = (await pending()).sort((a, b) => a.queuedAt - b.queuedAt);
  const result: FlushResult = { sent: 0, failed: 0, rejected: [] };

  for (const item of items) {
    try {
      await api.post(item.path, item.body);
      await forget(item.id);
      result.sent += 1;
    } catch (e) {
      item.attempts += 1;
      item.lastError = e instanceof Error ? e.message : String(e);

      if (e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 429) {
        result.rejected.push(item);
        await update(item);
      } else {
        result.failed += 1;
        await update(item);
        break; // still offline; stop hammering
      }
    }
  }
  return result;
}

export const isOnline = () => navigator.onLine;

/** Flushes on reconnect and every minute, so a clerk never has to think about it. */
export function startAutoFlush(onChange: (r: FlushResult & { queued: number }) => void) {
  let running = false;

  const run = async () => {
    if (running || !navigator.onLine) return;
    running = true;
    try {
      const before = (await pending()).length;
      if (before === 0) return;
      const r = await flush();
      onChange({ ...r, queued: (await pending()).length });
    } finally {
      running = false;
    }
  };

  window.addEventListener('online', run);
  const timer = setInterval(run, 60_000);
  void run();

  return () => {
    window.removeEventListener('online', run);
    clearInterval(timer);
  };
}
