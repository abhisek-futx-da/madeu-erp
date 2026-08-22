import React from 'react';

interface Props {
  legalName: string;
  gstin: string;
  fyLabel: string;
  online: boolean;
}

/** Identity strip. Values come from the signed-in tenant, never hardcoded. */
export const CompanyBanner: React.FC<Props> = ({ legalName, gstin, fyLabel, online }) => (
  <div className="bg-[#e9eef4] border-b border-[#b0c4de] select-none text-[12px]">
    <div className="bg-gradient-to-r from-[#1e3a8a] via-[#1e40af] to-[#2563eb] text-white px-3 py-1.5 flex items-center justify-between shadow-xs">
      <div className="flex items-center gap-3 font-semibold text-xs tracking-wide">
        <span className="bg-amber-400 text-slate-900 px-1.5 py-0.5 rounded text-[11px] font-bold uppercase shadow-xs">
          Link ERP
        </span>
        <span className="text-white drop-shadow-xs font-bold text-sm">{legalName}</span>
        <span className="text-blue-200">|</span>
        <span className="text-emerald-300 font-mono text-[11px]">GSTIN: {gstin}</span>
        <span className="text-blue-200">|</span>
        <span className="bg-blue-950/60 px-2 py-0.5 rounded border border-blue-400/40 text-[11px] text-amber-200">
          A/c Year : {fyLabel}
        </span>
      </div>

      <div className="flex items-center gap-1.5 bg-blue-900/80 px-2.5 py-0.5 rounded border border-blue-400/30 text-xs">
        <span className={`w-2 h-2 rounded-full ${online ? 'bg-emerald-400' : 'bg-red-400'}`}></span>
        <span className="text-blue-100 font-medium">{online ? 'Connected' : 'Offline'}</span>
      </div>
    </div>
  </div>
);
