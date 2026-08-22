import React, { useEffect } from 'react';
import { Plus, Printer, Search, Download, Save, RotateCcw } from 'lucide-react';

/**
 * Only actions this screen can actually perform. The previous version rendered
 * New, Edit, Delete, First, Back, Find, User Log and Exit unconditionally with
 * optional handlers — across thirteen screens that was 96 buttons whose onClick
 * was undefined. A button that does nothing when clicked is worse than an
 * absent one: it tells the user the software is broken.
 *
 * The shortcuts in the tooltips are wired below, so they are promises the app
 * keeps.
 */

export interface ToolbarAction {
  key: 'save' | 'new' | 'print' | 'find' | 'export' | 'reset';
  onRun: () => void;
  /** Disabled actions stay visible but inert and say why. */
  disabled?: boolean;
  hint?: string;
}

interface Props {
  title: string;
  actions?: ToolbarAction[];
  /** Legacy call sites pass these directly; both forms build the same list. */
  onSave?: () => void;
  onNew?: () => void;
  onPrint?: () => void;
  onFind?: () => void;
  onExport?: () => void;
}

const SPEC = {
  save:   { label: 'Save',   icon: Save,      combo: 'Ctrl+S', className: 'erp-btn-primary font-bold' },
  new:    { label: 'New',    icon: Plus,      combo: 'Ctrl+N', className: 'text-emerald-800 font-semibold' },
  print:  { label: 'Print',  icon: Printer,   combo: 'Ctrl+P', className: 'text-slate-700' },
  find:   { label: 'Find',   icon: Search,    combo: 'Ctrl+F', className: 'text-blue-800 font-semibold' },
  export: { label: 'Export', icon: Download,  combo: 'Ctrl+E', className: 'text-slate-700' },
  reset:  { label: 'Reset',  icon: RotateCcw, combo: 'Esc',    className: 'text-slate-600' }
} as const;

const COMBO_MATCH: Record<ToolbarAction['key'], (e: KeyboardEvent) => boolean> = {
  save:   e => (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's',
  new:    e => (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n',
  print:  e => (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'p',
  find:   e => (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f',
  export: e => (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'e',
  reset:  e => e.key === 'Escape'
};

export const ToolbarRibbon: React.FC<Props> = ({
  title, actions, onSave, onNew, onPrint, onFind, onExport
}) => {
  const list: ToolbarAction[] = actions ?? [
    ...(onSave ? [{ key: 'save' as const, onRun: onSave }] : []),
    ...(onNew ? [{ key: 'new' as const, onRun: onNew }] : []),
    ...(onFind ? [{ key: 'find' as const, onRun: onFind }] : []),
    ...(onExport ? [{ key: 'export' as const, onRun: onExport }] : []),
    ...(onPrint ? [{ key: 'print' as const, onRun: onPrint }] : [])
  ];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      for (const action of list) {
        if (action.disabled || !COMBO_MATCH[action.key](e)) continue;
        e.preventDefault();
        action.onRun();
        return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [list]);

  return (
    <div className="bg-gradient-to-b from-[#f8fafc] to-[#e2e8f0] border-b border-[#cbd5e1] px-3 py-1.5 flex items-center justify-between shadow-2xs print:hidden">
      <div className="flex items-center gap-1 flex-wrap">
        <div className="bg-[#1e40af] text-white px-2 py-0.5 rounded text-xs font-bold mr-2 shadow-2xs">
          {title}
        </div>

        {list.map(action => {
          const spec = SPEC[action.key];
          const Icon = spec.icon;
          return (
            <button
              key={action.key}
              type="button"
              onClick={action.onRun}
              disabled={action.disabled}
              title={action.hint ?? `${spec.label} (${spec.combo})`}
              className={`erp-btn ${spec.className} disabled:opacity-40 disabled:cursor-not-allowed`}
            >
              <Icon className="w-3.5 h-3.5" />
              <span>{spec.label}</span>
            </button>
          );
        })}
      </div>

      {list.length > 0 && (
        <div className="text-[11px] text-slate-600 hidden md:block">
          {list.filter(a => !a.disabled).map(a => `${SPEC[a.key].combo} ${SPEC[a.key].label}`).join('  ·  ')}
        </div>
      )}
    </div>
  );
};
