import React, { useEffect, useState } from 'react';
import { AlertTriangle, CloudUpload, WifiOff } from 'lucide-react';
import { pending, heldForReview, startAutoFlush } from '../lib/offlineQueue';

/** Shows what is waiting to reach the server, so a scan never just disappears. */
export const OfflineBadge: React.FC = () => {
  const [queued, setQueued] = useState(0);
  const [held, setHeld] = useState(0);
  const [online, setOnline] = useState(navigator.onLine);

  useEffect(() => {
    const refresh = () => {
      void pending().then(p => setQueued(p.length)).catch(() => {});
      void heldForReview().then(h => setHeld(h.length)).catch(() => {});
    };
    refresh();

    const stop = startAutoFlush(r => setQueued(r.queued));
    const on = () => { setOnline(true); refresh(); };
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    const t = setInterval(refresh, 5000);

    return () => {
      stop();
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
      clearInterval(t);
    };
  }, []);

  // A refused scan is the one thing a storekeeper must not be allowed to miss,
  // so it shows even when the network is fine and nothing is queued.
  if (online && queued === 0 && held === 0) return null;

  if (held > 0) {
    return (
      <span
        className="px-2 py-0.5 rounded border font-semibold flex items-center gap-1
                   bg-red-100 border-red-400 text-red-900"
        title="the server refused these scans; open Inventory - Offline Scan Queue"
      >
        <AlertTriangle className="w-3 h-3" />
        {held} refused{queued ? ` · ${queued} queued` : ''}
      </span>
    );
  }

  return (
    <span
      className={`px-2 py-0.5 rounded border font-semibold flex items-center gap-1 ${
        online
          ? 'bg-amber-100 border-amber-300 text-amber-900'
          : 'bg-red-100 border-red-300 text-red-900'
      }`}
      title={online ? 'sending queued scans' : 'working offline; scans are being saved locally'}
    >
      {online ? <CloudUpload className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
      {online ? `Syncing ${queued}` : `Offline${queued ? ` — ${queued} queued` : ''}`}
    </span>
  );
};
