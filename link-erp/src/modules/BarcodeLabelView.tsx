import React, { useState } from 'react';
import { ToolbarRibbon } from '../components/ToolbarRibbon';
import { useApi } from '../lib/useApi';
import type { PieceRow, Session } from '../lib/api';
import { code128DataUri } from '../lib/barcode';
import { Printer, Tag } from 'lucide-react';

/**
 * Label printing. The system stamps a barcode on every thaan and until now had
 * no way to put it on the cloth. Code 128 is generated locally as SVG, so this
 * prints from a machine with no internet.
 */
export const BarcodeLabelView: React.FC<{ session: Session }> = ({ session }) => {
  const [status, setStatus] = useState('grey_in_stock');
  const [lot, setLot] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const query = `/pieces?status=${status}${lot ? `&lotNo=${encodeURIComponent(lot)}` : ''}&limit=500`;
  const pieces = useApi<PieceRow[]>(query, [status, lot]);
  const rows = pieces.data ?? [];

  const toggle = (barcode: string) =>
    setPicked(prev => {
      const next = new Set(prev);
      next.has(barcode) ? next.delete(barcode) : next.add(barcode);
      return next;
    });

  const selected = rows.filter(r => picked.has(r.barcode));
  const toPrint = selected.length > 0 ? selected : rows;

  return (
    <div className="flex flex-col h-full bg-[#ecf1f7] text-slate-800 text-xs">
      <div className="no-print">
        <ToolbarRibbon title="Barcode Labels" onPrint={() => window.print()} />
      </div>

      <div className="no-print px-3 py-2 bg-white border-b border-slate-200 flex items-center gap-2">
        <Tag className="w-4 h-4 text-blue-700" />
        <label className="font-semibold" htmlFor="st">Stage</label>
        <select id="st" value={status} onChange={e => setStatus(e.target.value)} className="erp-input w-48">
          <option value="grey_in_stock">Grey in stock</option>
          <option value="received_finish">Received finish</option>
          <option value="cut_packed">Cut / packed</option>
          <option value="issued_to_dyeing">Out at dyeing</option>
        </select>
        <label className="font-semibold" htmlFor="lot">Lot</label>
        <input id="lot" value={lot} onChange={e => setLot(e.target.value)}
               placeholder="all lots" className="erp-input w-32 font-mono" />
        <span className="text-slate-500">
          {selected.length > 0
            ? `${selected.length} selected`
            : `${rows.length} pieces — printing all`}
        </span>
        <button onClick={() => setPicked(new Set())} className="erp-btn">Clear selection</button>
        <button onClick={() => window.print()} className="erp-btn erp-btn-primary font-bold ml-auto">
          <Printer className="w-3.5 h-3.5" />
          <span>Print {toPrint.length} label{toPrint.length === 1 ? '' : 's'}</span>
        </button>
      </div>

      <div className="flex-1 overflow-auto p-3 print-area">
        <div className="label-sheet">
          {toPrint.map(p => (
            <div
              key={p.barcode}
              onClick={() => toggle(p.barcode)}
              className={`label bg-white cursor-pointer ${
                picked.has(p.barcode) ? 'ring-2 ring-blue-600' : ''
              }`}
            >
              <div className="flex justify-between items-start">
                <div className="font-bold text-[10pt] leading-tight">
                  {session.tenant?.legalName ?? ''}
                </div>
                <div className="text-[8pt] text-right leading-tight">
                  <div>{p.quality}</div>
                  <div>{p.grade_code}</div>
                </div>
              </div>

              <img
                src={code128DataUri(p.barcode, { height: 40, module: 1.6 })}
                alt={p.barcode}
                className="w-full"
                style={{ height: '13mm', objectFit: 'contain' }}
              />

              <div className="flex justify-between items-end font-mono text-[9pt]">
                <span className="font-bold tracking-wider">{p.barcode}</span>
                <span>{Number(p.current_qty).toFixed(2)} MTR</span>
              </div>
              <div className="flex justify-between text-[7pt] text-slate-600">
                <span>Lot {p.lot_no || '—'}</span>
                <span>{p.design ?? ''}</span>
              </div>
            </div>
          ))}
        </div>

        {!pieces.loading && rows.length === 0 && (
          <p className="p-6 text-center text-slate-400 no-print">
            No pieces at this stage
          </p>
        )}
      </div>
    </div>
  );
};
