import React, { useCallback, useEffect, useState } from 'react';
import { ToolbarRibbon } from '../components/ToolbarRibbon';
import {
  pending, heldForReview, retryHeld, discardHeld, flush, isOnline, type QueuedScan
} from '../lib/offlineQueue';
import { AlertTriangle, CheckCircle2, CloudUpload, RotateCcw, Trash2, WifiOff } from 'lucide-react';

/**
 * What the godown scanned that has not reached the server.
 *
 * The queue itself always worked; what was missing was any way to deal with the
 * scans the server *refused*. Those used to sit in the browser being re-sent
 * every minute, collecting the same rejection forever, with nothing on any
 * screen to say why. A storekeeper's only signal was a badge counting up.
 *
 * A held scan is a document that was never recorded, so discarding one undoes
 * nothing — the goods were simply never entered, and the screen says so rather
 * than leaving somebody to guess.
 */

const LABEL: Record<string, string> = {
  '/grey-inwards': 'Grey inward',
  '/dyeing-issues': 'Issue to dyeing',
  '/dyeing-receipts': 'Receive from dyeing',
  '/cut-pack': 'Cut / pack',
  '/dispatches': 'Dispatch',
  '/stock-counts': 'Stock count'
};

const describe = (item: QueuedScan) => {
  const base = LABEL[item.path]
    ?? Object.entries(LABEL).find(([p]) => item.path.startsWith(p))?.[1]
    ?? item.path;
  const body = item.body as Record<string, unknown> | null;
  const barcodes = body && Array.isArray(body.barcodes) ? body.barcodes.length : null;
  const lines = body && Array.isArray(body.lines) ? body.lines.length : null;
  const scans = body && Array.isArray(body.scans) ? body.scans.length : null;
  const count = barcodes ?? lines ?? scans;
  return count === null ? base : `${base} — ${count} piece(s)`;
};

const when = (ms: number) => new Date(ms).toLocaleString('en-IN');

export const OfflineQueueView: React.FC = () => {
  const [waiting, setWaiting] = useState<QueuedScan[]>([]);
  const [held, setHeld] = useState<QueuedScan[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [online, setOnline] = useState(isOnline());

  const load = useCallback(async () => {
    try {
      const [w, h] = await Promise.all([pending(), heldForReview()]);
      setWaiting(w.sort((a, b) => a.queuedAt - b.queuedAt));
      setHeld(h.sort((a, b) => (b.heldAt ?? 0) - (a.heldAt ?? 0)));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
    const on = () => { setOnline(true); void load(); };
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    const timer = setInterval(() => void load(), 5000);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
      clearInterval(timer);
    };
  }, [load]);

  const sendNow = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const r = await flush();
      setNotice(
        `${r.sent} sent` +
        (r.rejected.length ? `, ${r.rejected.length} refused and held for you` : '') +
        (r.failed ? `, ${r.failed} still waiting for the network` : '')
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      await load();
    }
  };

  const putBack = async (item: QueuedScan) => {
    await retryHeld(item.id);
    setNotice(`${describe(item)} is back in the queue`);
    await load();
  };

  const discard = async (item: QueuedScan) => {
    const sure = window.confirm(
      `Throw away this scan?\n\n${describe(item)}\n\nIt was never recorded, so nothing is ` +
      `undone — but the goods it describes will not be in the system at all.`
    );
    if (!sure) return;
    await discardHeld(item.id);
    setNotice(`${describe(item)} discarded; it was never recorded`);
    await load();
  };

  return (
    <div className="flex flex-col h-full bg-[#ecf1f7] text-slate-800 text-xs">
      <ToolbarRibbon
        title="Offline Scan Queue"
        actions={[
          { key: 'save', onRun: sendNow, disabled: busy || !online || waiting.length === 0,
            hint: !online ? 'no network yet'
                  : waiting.length === 0 ? 'nothing is waiting' : undefined },
          { key: 'reset', onRun: () => void load() }
        ]}
      />

      {(error || notice) && (
        <div className={`px-4 py-1.5 flex items-center gap-2 font-semibold ${
          error ? 'bg-red-600 text-white' : 'bg-emerald-600 text-white'
        }`}>
          {error ? <AlertTriangle className="w-4 h-4 shrink-0" /> : <CheckCircle2 className="w-4 h-4 shrink-0" />}
          <span>{error ?? notice}</span>
        </div>
      )}

      <div className="p-3 flex-1 overflow-y-auto max-w-5xl mx-auto w-full space-y-3">
        <div className={`rounded border p-3 flex items-center gap-2 font-semibold ${
          online ? 'bg-white border-[#b8c9dd]' : 'bg-red-50 border-red-300 text-red-900'
        }`}>
          {online ? <CloudUpload className="w-4 h-4 text-blue-700" /> : <WifiOff className="w-4 h-4" />}
          {online
            ? <span>Connected. {waiting.length} scan(s) waiting to be sent.</span>
            : <span>No network. {waiting.length} scan(s) are saved here and will go when it returns.</span>}
        </div>

        {held.length > 0 && (
          <div className="bg-white rounded border border-red-300 overflow-hidden">
            <div className="bg-red-100 border-b border-red-300 px-2 py-1.5 font-bold text-red-900">
              {held.length} scan(s) the server refused — these need you
            </div>
            <p className="px-2 py-2 text-slate-700 border-b border-slate-200">
              These will not be sent again on their own. The server judged them, so
              sending the same thing again gives the same answer. Fix whatever it
              names — a missing master, a barcode already used, a closed period —
              then put it back in the queue.
            </p>
            <table className="w-full">
              <thead className="border-b border-slate-200 text-left text-slate-600">
                <tr>
                  <th className="px-2 py-1">What</th>
                  <th className="px-2 py-1">Scanned</th>
                  <th className="px-2 py-1">Why it was refused</th>
                  <th className="px-2 py-1 w-40"></th>
                </tr>
              </thead>
              <tbody>
                {held.map(item => (
                  <tr key={item.id} className="border-b border-slate-100 align-top">
                    <td className="px-2 py-1.5 font-semibold">{describe(item)}</td>
                    <td className="px-2 py-1.5 whitespace-nowrap">{when(item.queuedAt)}</td>
                    <td className="px-2 py-1.5 text-red-800">{item.lastError ?? 'refused'}</td>
                    <td className="px-2 py-1.5 text-right whitespace-nowrap">
                      <button onClick={() => void putBack(item)} className="erp-btn py-1">
                        <RotateCcw className="w-3 h-3" /> Try again
                      </button>
                      <button onClick={() => void discard(item)} className="erp-btn py-1 ml-1">
                        <Trash2 className="w-3 h-3 text-red-600" /> Discard
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="bg-white rounded border border-[#b8c9dd] overflow-hidden">
          <div className="bg-slate-100 border-b border-slate-300 px-2 py-1.5 font-bold">
            Waiting to be sent
          </div>
          <table className="w-full">
            <tbody>
              {waiting.length === 0 && (
                <tr><td className="px-2 py-6 text-center text-slate-400">
                  Nothing is waiting. Every scan has reached the server.
                </td></tr>
              )}
              {waiting.map(item => (
                <tr key={item.id} className="border-b border-slate-100">
                  <td className="px-2 py-1.5 font-semibold">{describe(item)}</td>
                  <td className="px-2 py-1.5 whitespace-nowrap">{when(item.queuedAt)}</td>
                  <td className="px-2 py-1.5 text-slate-500">
                    {item.attempts > 0 ? `${item.attempts} attempt(s)` : 'not tried yet'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
