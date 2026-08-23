import React, { useState } from 'react';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { ToolbarRibbon } from '../components/ToolbarRibbon';
import { useApi, useSubmit } from '../lib/useApi';
import { api, ApiError } from '../lib/api';

const passwordHint = 'Use 12+ characters with uppercase, lowercase, and a number.';

/** Every signed-in worker can rotate their own password.  An owner reset is
 * deliberately not a substitute: changing an account password requires the
 * worker's existing password. */
export const PasswordView: React.FC = () => {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const { submit, busy, error } = useSubmit<{
    currentPassword: string; newPassword: string;
  }, { passwordChanged: boolean }>('/auth/password');
  const mfa = useApi<{ enabled: boolean; pending: boolean; enabledAt: string | null;
    recoveryCodesLeft: number; audit: Array<{ event: string; occurred_at: string }> }>('/auth/mfa');
  const [mfaPassword, setMfaPassword] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const [setup, setSetup] = useState<{ secret: string; otpauthUri: string; recoveryCodes: string[] } | null>(null);
  const [mfaNotice, setMfaNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [mfaBusy, setMfaBusy] = useState(false);

  const save = async () => {
    setNotice(null);
    if (newPassword !== confirmation) {
      setNotice('The new password and confirmation do not match.');
      return;
    }
    const result = await submit({ currentPassword, newPassword });
    if (result) {
      setCurrentPassword('');
      setNewPassword('');
      setConfirmation('');
      setNotice('Password changed. Your other signed-in sessions have been invalidated.');
    }
  };

  const mfaRun = async (work: () => Promise<void>) => {
    setMfaBusy(true); setMfaNotice(null);
    try { await work(); mfa.reload(); }
    catch (e) { setMfaNotice({ kind: 'error', text: e instanceof ApiError ? e.message : String(e) }); }
    finally { setMfaBusy(false); }
  };

  const startMfa = () => mfaRun(async () => {
    const out = await api.post<{ secret: string; otpauthUri: string; recoveryCodes: string[] }>(
      '/auth/mfa/setup', { currentPassword: mfaPassword });
    setSetup(out); setMfaCode('');
    setMfaNotice({ kind: 'ok', text: 'Authenticator setup started. Save the recovery codes before enabling it.' });
  });
  const turnOnMfa = () => mfaRun(async () => {
    await api.post('/auth/mfa/enable', { code: mfaCode });
    setMfaCode('');
    setMfaNotice({ kind: 'ok', text: 'Multi-factor authentication is enabled. Keep the recovery codes offline.' });
  });
  const turnOffMfa = () => mfaRun(async () => {
    await api.post('/auth/mfa/disable', { currentPassword: mfaPassword, code: mfaCode });
    setSetup(null); setMfaCode(''); setMfaPassword('');
    setMfaNotice({ kind: 'ok', text: 'MFA disabled. All existing sessions are invalid; sign in again.' });
    window.setTimeout(() => window.location.reload(), 1500);
  });

  return (
    <div className="flex flex-col h-full overflow-auto bg-[#ecf1f7] text-slate-800 text-xs">
      <ToolbarRibbon title="My Password" onSave={save} onNew={() => {
        setCurrentPassword(''); setNewPassword(''); setConfirmation(''); setNotice(null);
      }} />
      {(notice || error) && (
        <div className={`px-4 py-2 flex items-center gap-2 font-semibold ${
          error ? 'bg-red-600 text-white' : 'bg-emerald-600 text-white'
        }`}>
          {error ? <AlertTriangle className="w-4 h-4" /> : <CheckCircle2 className="w-4 h-4" />}
          <span>{error ?? notice}</span>
        </div>
      )}
      <div className="p-4">
        <div className="max-w-3xl space-y-4">
        <section className="rounded border border-[#b8c9dd] bg-white p-5 shadow-sm">
          <h1 className="text-sm font-bold text-slate-900">Change your password</h1>
          <p className="mt-1 text-slate-600">{passwordHint}</p>
          <div className="mt-4 grid gap-3">
            <label className="erp-label">Current password
              <input className="erp-input mt-1 w-full" type="password" autoComplete="current-password"
                     value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} />
            </label>
            <label className="erp-label">New password
              <input className="erp-input mt-1 w-full" type="password" autoComplete="new-password"
                     value={newPassword} onChange={e => setNewPassword(e.target.value)} />
            </label>
            <label className="erp-label">Confirm new password
              <input className="erp-input mt-1 w-full" type="password" autoComplete="new-password"
                     value={confirmation} onChange={e => setConfirmation(e.target.value)} />
            </label>
            <button type="button" onClick={save} disabled={busy} className="erp-btn erp-btn-primary justify-center disabled:opacity-50">
              {busy ? 'Changing…' : 'Change password'}
            </button>
          </div>
        </section>
        <section className="rounded border border-[#b8c9dd] bg-white p-5 shadow-sm" aria-labelledby="mfa-title">
          <h2 id="mfa-title" className="text-sm font-bold text-slate-900">Authenticator multi-factor security</h2>
          <p className="mt-1 text-slate-600">Required before pilot for every owner and accounts user. The authenticator secret is encrypted; recovery codes are shown once and stored only as hashes.</p>
          {mfaNotice && <div role={mfaNotice.kind === 'error' ? 'alert' : 'status'} className={`mt-3 rounded border p-3 font-semibold ${mfaNotice.kind === 'error' ? 'bg-red-50 border-red-300 text-red-900' : 'bg-emerald-50 border-emerald-300 text-emerald-950'}`}>{mfaNotice.text}</div>}
          <div className="mt-3 rounded border border-slate-300 bg-slate-50 p-3">
            <strong>Status: {mfa.data?.enabled ? 'Enabled' : mfa.data?.pending ? 'Setup not yet confirmed' : 'Not enabled'}</strong>
            {mfa.data?.enabled && <span className="ml-3 text-slate-600">{mfa.data.recoveryCodesLeft} recovery code(s) left</span>}
          </div>

          {!mfa.data?.enabled && <div className="mt-4 grid gap-3">
            <label className="erp-label">Current password
              <input className="erp-input mt-1 w-full" type="password" autoComplete="current-password" value={mfaPassword} onChange={e => setMfaPassword(e.target.value)} />
            </label>
            <button className="erp-btn justify-center" disabled={mfaBusy || !mfaPassword} onClick={startMfa}>{mfa.data?.pending ? 'Restart authenticator setup' : 'Start authenticator setup'}</button>
          </div>}

          {setup && !mfa.data?.enabled && <div className="mt-4 space-y-3 border-t border-slate-200 pt-4">
            <div><strong>1. Add this account to your authenticator.</strong><p className="text-slate-600 mt-1">Manual secret:</p><code className="block mt-1 rounded bg-slate-900 text-white p-3 font-mono break-all select-text">{setup.secret}</code></div>
            <details><summary className="cursor-pointer font-semibold min-h-11 flex items-center">Show full authenticator URI</summary><code className="block rounded bg-slate-100 border p-2 break-all select-text">{setup.otpauthUri}</code></details>
            <div><strong>2. Save these one-time recovery codes offline now.</strong><pre className="mt-2 grid grid-cols-2 gap-1 rounded border bg-amber-50 border-amber-300 p-3 font-mono select-text whitespace-pre-wrap">{setup.recoveryCodes.join('\n')}</pre></div>
            <label className="erp-label block">3. Enter the current six-digit authenticator code
              <input className="erp-input mt-1 w-full font-mono tracking-widest" inputMode="numeric" autoComplete="one-time-code" value={mfaCode} onChange={e => setMfaCode(e.target.value)} />
            </label>
            <button className="erp-btn erp-btn-primary justify-center" disabled={mfaBusy || !/^\d{6}$/.test(mfaCode)} onClick={turnOnMfa}>Enable MFA</button>
          </div>}

          {mfa.data?.enabled && <div className="mt-4 grid gap-3 border-t border-slate-200 pt-4">
            <p className="text-red-800 font-semibold">Disabling MFA invalidates every existing session. Use your current password and an unused authenticator or recovery code.</p>
            <label className="erp-label">Current password<input className="erp-input mt-1 w-full" type="password" autoComplete="current-password" value={mfaPassword} onChange={e => setMfaPassword(e.target.value)} /></label>
            <label className="erp-label">Authenticator or recovery code<input className="erp-input mt-1 w-full font-mono" autoComplete="one-time-code" value={mfaCode} onChange={e => setMfaCode(e.target.value)} /></label>
            <button className="erp-btn justify-center border-red-400 text-red-800" disabled={mfaBusy || !mfaPassword || mfaCode.length < 6} onClick={turnOffMfa}>Disable MFA and sign out everywhere</button>
          </div>}
        </section>
        </div>
      </div>
    </div>
  );
};
