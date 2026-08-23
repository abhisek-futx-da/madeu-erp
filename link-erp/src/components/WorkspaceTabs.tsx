import React from 'react';
import { X } from 'lucide-react';

export interface WorkspaceTab { id: string; label: string }

interface Props {
  tabs: WorkspaceTab[];
  activeId: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
}

/**
 * Keeps several ERP documents mounted so a clerk can compare a challan,
 * invoice and ledger without losing half-entered form state.
 */
export const WorkspaceTabs: React.FC<Props> = ({ tabs, activeId, onSelect, onClose }) => {
  const activeTab = tabs.find(tab => tab.id === activeId) ?? tabs[0];
  const move = (current: number, direction: -1 | 1) => {
    if (tabs.length < 2) return;
    const next = (current + direction + tabs.length) % tabs.length;
    onSelect(tabs[next]!.id);
  };

  return (
    <div className="bg-slate-200 border-b border-slate-400 px-2 overflow-x-auto flex items-end" aria-label="Open workspaces">
      <div role="tablist" aria-label="Open ERP screens" className="flex items-end gap-1 min-w-max pt-1 flex-1">
        {tabs.map((tab, index) => {
          const active = tab.id === activeId;
          return (
            <button key={tab.id} type="button" role="tab" aria-selected={active}
              aria-controls={`workspace-panel-${tab.id}`} id={`workspace-tab-${tab.id}`}
              tabIndex={active ? 0 : -1} onClick={() => onSelect(tab.id)}
              onKeyDown={event => {
                if (event.key === 'ArrowLeft') { event.preventDefault(); move(index, -1); }
                if (event.key === 'ArrowRight') { event.preventDefault(); move(index, 1); }
              }}
              className={`min-h-11 px-3 py-1.5 text-xs font-semibold whitespace-nowrap rounded-t border ${
              active ? 'bg-white border-slate-400 border-b-white text-blue-950' :
                'bg-slate-100 border-slate-300 text-slate-600 hover:bg-white'
            }`}>
              {tab.label}
            </button>
          );
        })}
      </div>
      {tabs.length > 1 && activeTab && (
        <button type="button" onClick={() => onClose(activeTab.id)}
          aria-label={`Close ${activeTab.label}`} title={`Close ${activeTab.label}`}
          className="min-h-11 min-w-11 px-2 mb-px flex shrink-0 items-center justify-center rounded-t border border-slate-300 bg-slate-100 text-slate-600 hover:bg-white hover:text-red-700">
          <X className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
};
