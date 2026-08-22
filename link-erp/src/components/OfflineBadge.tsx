import React, { useEffect, useState } from 'react';
import { CloudUpload, WifiOff } from 'lucide-react';
import { pending, startAutoFlush } from '../lib/offlineQueue';

/** Shows what is waiting to reach the server, so a scan never just disappears. */
export const OfflineBadge: React.FC = () => {
  const [queued, setQueued] = useState(0);
  const [online, setOnline] = useState(navigator.onLine);

  useEffect(() => {
    const refresh = () => void pending().then(p => setQueued(p.length)).catch(() => {});
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

  if (online && queued === 0) return null;

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
