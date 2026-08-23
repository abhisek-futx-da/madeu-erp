import React, { useEffect, useState } from 'react';
import { Wifi, WifiOff, Clock, Terminal } from 'lucide-react';

interface Props {
  currentForm: string;
  actionText?: string;
  tenantName: string;
  gstin: string;
  userEmail: string;
  online: boolean;
}

export const StatusBar: React.FC<Props> = ({
  currentForm, actionText = 'READY', tenantName, gstin, userEmail, online
}) => {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  return (
    <footer className="bg-[#0f172a] text-slate-300 text-[11px] font-mono border-t border-slate-700 px-3 py-1 flex flex-wrap items-center gap-2 justify-between select-none">
      <div className="flex min-w-0 items-center gap-2 md:gap-4">
        <div className="flex items-center gap-1.5 text-blue-400 font-bold">
          <Terminal className="w-3.5 h-3.5" />
          <span>Link ERP</span>
        </div>
        <span className="hidden sm:inline text-slate-600">|</span>
        <span className="hidden sm:inline text-amber-300 font-semibold truncate">{tenantName}</span>
        <span className="hidden md:inline text-slate-600">|</span>
        <span className="hidden md:inline text-emerald-400">{gstin}</span>
        <span className="hidden lg:inline text-slate-600">|</span>
        <span className="hidden lg:inline text-slate-400">{userEmail}</span>
      </div>

      <div className="flex items-center gap-2 md:gap-4">
        <div className="hidden sm:flex items-center gap-1 text-slate-400">
          <Clock className="w-3 h-3 text-cyan-400" />
          <span>{now.toLocaleString('en-GB')}</span>
        </div>
        <span className="hidden sm:inline text-slate-600">|</span>
        <div className={`flex items-center gap-1 ${online ? 'text-emerald-400' : 'text-red-400'}`}>
          {online ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
          <span>{online ? 'Connected' : 'Offline'}</span>
        </div>
        <span className="hidden md:inline text-slate-600">|</span>
        <div className="hidden md:block bg-blue-900/90 text-blue-200 px-2 py-0.5 rounded border border-blue-500/50 text-[10px] font-bold">
          {currentForm} &gt; {actionText}
        </div>
      </div>
    </footer>
  );
};
