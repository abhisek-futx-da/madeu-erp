import React from 'react';
import { AlertTriangle } from 'lucide-react';

interface State { error: Error | null }

/**
 * Without this a single render error blanked the whole application and the
 * clerk lost whatever they were typing with no explanation.
 */
export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('render failed', error, info.componentStack);
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="h-full flex items-center justify-center bg-[#ecf1f7] p-8">
        <div className="bg-white border border-red-300 rounded shadow max-w-lg p-5 space-y-3">
          <div className="flex items-center gap-2 text-red-800 font-bold">
            <AlertTriangle className="w-5 h-5" />
            <span>This screen could not be drawn</span>
          </div>
          <p className="text-xs text-slate-600">
            Nothing you have already saved is affected. Go back to another screen, or
            reload if it keeps happening.
          </p>
          <pre className="text-[11px] bg-slate-50 border border-slate-200 rounded p-2 overflow-auto max-h-40">
            {this.state.error.message}
          </pre>
          <div className="flex gap-2 justify-end">
            <button onClick={() => this.setState({ error: null })} className="erp-btn">
              Try again
            </button>
            <button onClick={() => location.reload()} className="erp-btn erp-btn-primary font-bold">
              Reload
            </button>
          </div>
        </div>
      </div>
    );
  }
}
