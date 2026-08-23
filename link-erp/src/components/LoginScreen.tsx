import React, { useState } from 'react';
import { Lock, LogIn, AlertCircle } from 'lucide-react';
import { auth } from '../lib/api';

interface Props {
  onSignedIn: (tenant: string, role: string) => void;
}

export const LoginScreen: React.FC<Props> = ({ onSignedIn }) => {
  // Convenience for the demo build only; production starts empty.
  const [email, setEmail] = useState(import.meta.env.DEV ? 'owner@neelkamal.test' : '');
  const [password, setPassword] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const [mfaRequired, setMfaRequired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const signIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
      setError(null);
      try {
      const out = await auth.login(email, password, mfaRequired ? mfaCode : undefined);
      if ('mfaRequired' in out) {
        setMfaRequired(true);
        return;
      }
      onSignedIn(out.tenant, out.role);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'sign in failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="h-screen w-screen flex items-center justify-center bg-[#dce5f0]">
      <form
        onSubmit={signIn}
        className="bg-white border border-[#b8c9dd] rounded-md shadow-lg w-[380px] p-6 space-y-4"
      >
        <div className="flex items-center gap-2 pb-3 border-b border-slate-200">
          <div className="bg-blue-800 text-white p-2 rounded">
            <Lock className="w-4 h-4" />
          </div>
          <div>
            <h1 className="font-bold text-slate-900 text-sm">Link ERP</h1>
            <p className="text-[11px] text-slate-500">Textile Management Suite</p>
          </div>
        </div>

        {error && (
          <div className="flex items-start gap-2 bg-red-50 border border-red-200 text-red-800 rounded px-3 py-2 text-xs">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        <div>
          <label className="erp-label block" htmlFor="email">Email</label>
          <input
            id="email" type="email" required autoComplete="username"
            value={email} onChange={e => { setEmail(e.target.value); setMfaRequired(false); setMfaCode(''); }}
            className="erp-input w-full"
          />
        </div>

        <div>
          <label className="erp-label block" htmlFor="password">Password</label>
          <input
            id="password" type="password" required autoComplete="current-password"
            value={password} onChange={e => { setPassword(e.target.value); setMfaRequired(false); setMfaCode(''); }}
            className="erp-input w-full"
          />
        </div>

        {mfaRequired && (
          <div>
            <label className="erp-label block" htmlFor="mfa-code">Authenticator or recovery code</label>
            <input id="mfa-code" required autoComplete="one-time-code" inputMode="numeric"
              value={mfaCode} onChange={e => setMfaCode(e.target.value)} autoFocus
              className="erp-input w-full font-mono tracking-widest" />
            <p className="mt-1 text-[11px] text-slate-600">Your password was accepted. Enter the six-digit code, or one unused recovery code.</p>
          </div>
        )}

        <button
          type="submit" disabled={busy}
          className="erp-btn erp-btn-primary font-bold w-full justify-center py-1.5 disabled:opacity-60"
        >
          <LogIn className="w-3.5 h-3.5" />
          <span>{busy ? 'Signing in…' : mfaRequired ? 'Verify & Sign In' : 'Sign In'}</span>
        </button>
      </form>
    </div>
  );
};
