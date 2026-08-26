import React, { useCallback, useEffect, useState } from 'react';
import {
  portalApi, portalToken, PortalError,
  DECLARATION_LABEL, STATE_LABEL,
  type PortalChallan, type PortalPiece, type PortalDeclaration
} from '../lib/portalApi';
import { LANGUAGES, useLang, type Lang } from '../lib/i18n';

/**
 * What a dyeing house sees.
 *
 * Built for a phone in a godown office, not a desk: one column, large targets,
 * few words. It can look at its own custody and say things about it. There is
 * no screen here that moves a thaan or touches a rupee, because there is no
 * endpoint behind one — the mill's own staff accept what is said.
 */

type Tab = 'challans' | 'pieces' | 'said';

export const PortalApp: React.FC = () => {
  const [signedIn, setSignedIn] = useState(!!portalToken());
  const [mill, setMill] = useState('');
  const [party, setParty] = useState('');

  if (!signedIn) {
    return <PortalSignIn onIn={(m, p) => { setMill(m); setParty(p); setSignedIn(true); }} />;
  }
  return (
    <PortalHome
      mill={mill} party={party}
      onOut={() => { portalApi.signOut(); setSignedIn(false); }}
    />
  );
};

// ----------------------------------------------------------------- sign in --

const PortalSignIn: React.FC<{ onIn: (mill: string, party: string) => void }> = ({ onIn }) => {
  const { lang, setLang, reviewed, t } = useLang();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const out = await portalApi.signIn(email, password);
      onIn(out.mill, out.party);
    } catch (err) {
      setError(err instanceof PortalError ? err.message : 'sign in failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-100 flex items-center justify-center p-4">
      <form onSubmit={submit}
            className="bg-white w-full max-w-sm rounded-lg border border-slate-300 shadow p-5 space-y-4">
        <div>
          <div className="flex items-start justify-between gap-3">
            <h1 className="text-lg font-bold text-slate-900">{t('Process House Portal')}</h1>
            <LanguageSelect lang={lang} setLang={setLang} />
          </div>
          <p className="text-sm text-slate-500">
            {t('Goods you are holding, and what you want to tell the mill.')}
          </p>
        </div>

        {!reviewed && <TranslationNotice text={t('This translation has not been checked by a native speaker yet.')} />}

        {error && (
          <p role="alert" className="bg-red-50 border border-red-300 text-red-800 rounded p-3 text-sm">
            {error}
          </p>
        )}

        <div>
          <label htmlFor="portal-email" className="block text-sm font-semibold mb-1">{t('Email')}</label>
          <input id="portal-email" type="email" required autoComplete="username"
                 value={email} onChange={e => setEmail(e.target.value)}
                 className="w-full border border-slate-300 rounded px-3 py-3 text-base" />
        </div>
        <div>
          <label htmlFor="portal-password" className="block text-sm font-semibold mb-1">{t('Password')}</label>
          <input id="portal-password" type="password" required autoComplete="current-password"
                 value={password} onChange={e => setPassword(e.target.value)}
                 className="w-full border border-slate-300 rounded px-3 py-3 text-base" />
        </div>

        <button type="submit" disabled={busy}
                className="w-full bg-blue-800 text-white font-bold rounded py-3 text-base disabled:opacity-60">
          {busy ? t('Signing in…') : t('Sign in')}
        </button>
      </form>
    </div>
  );
};

// -------------------------------------------------------------------- home --

const PortalHome: React.FC<{ mill: string; party: string; onOut: () => void }> =
({ mill, party, onOut }) => {
  const { lang, setLang, reviewed, t } = useLang();
  const [tab, setTab] = useState<Tab>('challans');
  const [challans, setChallans] = useState<PortalChallan[]>([]);
  const [pieces, setPieces] = useState<PortalPiece[]>([]);
  const [said, setSaid] = useState<PortalDeclaration[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [speaking, setSpeaking] = useState<PortalChallan | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [c, p, d] = await Promise.all([
        portalApi.get<PortalChallan[]>('/challans'),
        portalApi.get<PortalPiece[]>('/pieces'),
        portalApi.get<PortalDeclaration[]>('/declarations')
      ]);
      setChallans(c); setPieces(p); setSaid(d);
      setError(null);
    } catch (err) {
      setError(err instanceof PortalError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const waiting = challans.filter(c => !c.acknowledged_at).length;

  return (
    <div className="min-h-screen bg-slate-100 text-slate-800">
      <header className="bg-blue-900 text-white px-4 py-3 sticky top-0 z-10">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="font-bold truncate">{party || 'Process house'}</p>
            <p className="text-xs text-blue-200 truncate">holding goods for {mill || 'the mill'}</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <LanguageSelect lang={lang} setLang={setLang} dark />
            <button onClick={onOut} className="text-xs underline py-2">{t('Sign out')}</button>
          </div>
        </div>
      </header>

      {!reviewed && <TranslationNotice text={t('This translation has not been checked by a native speaker yet.')} />}

      <nav className="flex bg-white border-b border-slate-300 sticky top-[60px] z-10">
        {([
          ['challans', `${t('Challans')}${waiting ? ` (${waiting})` : ''}`],
          ['pieces', `${t('Thaans')} (${pieces.length})`],
          ['said', t('What I told the mill')]
        ] as const).map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)}
                  className={`flex-1 py-3 text-sm font-semibold border-b-2 ${
                    tab === id ? 'border-blue-800 text-blue-900' : 'border-transparent text-slate-500'
                  }`}>
            {label}
          </button>
        ))}
      </nav>

      {(error || notice) && (
        <p role="alert" className={`px-4 py-3 text-sm font-semibold ${
          error ? 'bg-red-600 text-white' : 'bg-emerald-600 text-white'
        }`}>{error ?? notice}</p>
      )}

      <main className="p-3 space-y-3 max-w-2xl mx-auto">
        {loading && <p className="text-slate-500 p-4 text-center">{t('Loading…')}</p>}

        {!loading && tab === 'challans' && (
          challans.length === 0
            ? <Empty>{t('The mill has not sent you anything yet.')}</Empty>
            : challans.map(c => (
                <ChallanCard key={c.issue_id} challan={c} onSpeak={() => setSpeaking(c)} t={t} />
              ))
        )}

        {!loading && tab === 'pieces' && (
          pieces.length === 0
            ? <Empty>{t('You are not holding any thaans right now.')}</Empty>
            : pieces.map(p => (
                <div key={p.piece_id} className="bg-white rounded-lg border border-slate-300 p-3">
                  <div className="flex justify-between gap-2">
                    <span className="font-mono font-bold text-blue-900">{p.barcode}</span>
                    <span className="font-mono">{Number(p.current_qty).toFixed(2)} {p.uom}</span>
                  </div>
                  <p className="text-sm text-slate-600">
                    {p.quality}{p.design ? ` · ${p.design}` : ''} · lot {p.lot_no || '—'}
                    {p.challan_no ? ` · challan ${p.challan_no}` : ''}
                  </p>
                </div>
              ))
        )}

        {!loading && tab === 'said' && (
          said.length === 0
            ? <Empty>{t('You have not told the mill anything yet.')}</Empty>
            : said.map(d => (
                <div key={d.declaration_id} className="bg-white rounded-lg border border-slate-300 p-3">
                  <div className="flex justify-between gap-2 items-start">
                    <span className="font-bold">{t(DECLARATION_LABEL[d.kind] ?? d.kind)}</span>
                    <span className={`text-xs px-2 py-1 rounded font-bold shrink-0 ${
                      d.state === 'accepted' ? 'bg-emerald-100 text-emerald-900'
                      : d.state === 'rejected' ? 'bg-red-100 text-red-900'
                      : 'bg-amber-100 text-amber-900'
                    }`}>{t(STATE_LABEL[d.state] ?? d.state)}</span>
                  </div>
                  <p className="text-sm text-slate-600 mt-1">
                    {d.challan_no ? `Challan ${d.challan_no} · ` : ''}
                    {d.pieces > 0 ? `${d.pieces} thaan(s) · ` : ''}
                    {new Date(d.declared_at).toLocaleDateString('en-IN')}
                  </p>
                  {d.note && <p className="text-sm mt-1">{d.note}</p>}
                  {d.mill_note && (
                    <p className="text-sm mt-2 border-t border-slate-200 pt-2 text-slate-700">
                    {t('Mill')}: {d.mill_note}
                    </p>
                  )}
                </div>
              ))
        )}
      </main>

      {speaking && (
        <SpeakSheet
          challan={speaking}
          pieces={pieces.filter(p => p.entry_no === speaking.entry_no)}
          onClose={() => setSpeaking(null)}
          onDone={message => {
            setSpeaking(null);
            setNotice(message);
            setError(null);
            void load();
          }}
          onError={setError}
        />
      )}
    </div>
  );
};

const Empty: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <p className="text-slate-500 text-center p-8 bg-white rounded-lg border border-slate-200">
    {children}
  </p>
);

const ChallanCard: React.FC<{
  challan: PortalChallan; onSpeak: () => void;
  t: (english: string, vars?: Record<string, string | number>) => string;
}> = ({ challan, onSpeak, t }) => (
  <div className="bg-white rounded-lg border border-slate-300 p-3 space-y-2">
    <div className="flex justify-between gap-2 items-start">
      <div className="min-w-0">
        <p className="font-mono font-bold text-blue-900">{challan.challan_no}</p>
        <p className="text-sm text-slate-600">
          {challan.challan_date} · {challan.pieces} thaan(s) ·{' '}
          {Number(challan.issued_qty).toFixed(2)} mtr
        </p>
      </div>
      {challan.acknowledged_at
        ? <span className="text-xs bg-emerald-100 text-emerald-900 px-2 py-1 rounded font-bold shrink-0">
            {t('Received')}
          </span>
        : <span className="text-xs bg-amber-100 text-amber-900 px-2 py-1 rounded font-bold shrink-0">
            {t('Not confirmed')}
          </span>}
    </div>
    {challan.expected_on && (
      <p className="text-sm text-slate-600">Return expected {challan.expected_on}</p>
    )}
    <button onClick={onSpeak}
            className="w-full bg-blue-800 text-white font-bold rounded py-3 text-base">
      {t('Tell the mill something')}
    </button>
  </div>
);

// ------------------------------------------------------------------ speaking --

const KINDS = [
  ['custody_ack', 'We have received these goods'],
  ['expected_return', 'We will return them by a date'],
  ['shortage', 'Fewer arrived than the challan says'],
  ['rejection', 'Some are damaged or off-shade'],
  ['return_dispatch', 'We have sent them back']
] as const;

const NEEDS_PIECES = new Set(['shortage', 'rejection', 'return_dispatch']);

const SpeakSheet: React.FC<{
  challan: PortalChallan;
  pieces: PortalPiece[];
  onClose: () => void;
  onDone: (message: string) => void;
  onError: (message: string) => void;
}> = ({ challan, pieces, onClose, onDone, onError }) => {
  const { t } = useLang();
  const [kind, setKind] = useState<string>('custody_ack');
  const [note, setNote] = useState('');
  const [theirRef, setTheirRef] = useState('');
  const [vehicleNo, setVehicleNo] = useState('');
  const [expectedOn, setExpectedOn] = useState('');
  const [chosen, setChosen] = useState<Record<string, boolean>>({});
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const needsPieces = NEEDS_PIECES.has(kind);
  const picked = Object.entries(chosen).filter(([, on]) => on).map(([b]) => b);
  const pieceDetailsReady = kind === 'shortage'
    ? picked.every(barcode => Number(quantities[barcode]) > 0)
    : kind === 'rejection'
      ? picked.every(barcode => (reasons[barcode] ?? '').trim().length > 0)
      : true;
  const ready = (!needsPieces || picked.length > 0)
    && pieceDetailsReady
    && (kind !== 'expected_return' || !!expectedOn)
    && (kind !== 'return_dispatch' || (!!theirRef.trim() && !!vehicleNo.trim()));

  const send = async () => {
    setBusy(true);
    try {
      await portalApi.post('/declarations', {
        kind,
        issueId: kind === 'return_dispatch' ? challan.issue_id : challan.issue_id,
        theirRef, note,
        vehicleNo: vehicleNo || null,
        expectedOn: kind === 'expected_return' ? expectedOn : null,
        lines: needsPieces ? picked.map(barcode => ({
          barcode,
          qty: quantities[barcode] ? Number(quantities[barcode]) : undefined,
          reason: reasons[barcode]?.trim() || undefined
        })) : undefined
      });
      onDone(`${t('Sent to the mill')}: ${t(DECLARATION_LABEL[kind])}`);
    } catch (err) {
      onError(err instanceof PortalError ? err.message : String(err));
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-20"
         role="dialog" aria-label={t('Tell the mill something')}>
      <div className="bg-white w-full sm:max-w-lg rounded-t-xl sm:rounded-xl p-4
                      space-y-3 max-h-[90vh] overflow-y-auto">
        <div className="flex justify-between items-center">
          <h2 className="font-bold">Challan {challan.challan_no}</h2>
          <button onClick={onClose} className="text-slate-500 py-2 px-3">{t('Close')}</button>
        </div>

        <div>
          <label htmlFor="speak-kind" className="block text-sm font-semibold mb-1">
            {t('What do you want to say?')}
          </label>
          <select id="speak-kind" value={kind} onChange={e => setKind(e.target.value)}
                  className="w-full border border-slate-300 rounded px-3 py-3 text-base">
            {KINDS.map(([id, label]) => <option key={id} value={id}>{t(label)}</option>)}
          </select>
        </div>

        {kind === 'expected_return' && (
          <div>
            <label htmlFor="speak-date" className="block text-sm font-semibold mb-1">
              {t('Expected return date')}
            </label>
            <input id="speak-date" type="date" value={expectedOn}
                   onChange={e => setExpectedOn(e.target.value)}
                   className="w-full border border-slate-300 rounded px-3 py-3 text-base" />
          </div>
        )}

        {kind === 'return_dispatch' && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="speak-ref" className="block text-sm font-semibold mb-1">* {t('Your challan')}</label>
              <input id="speak-ref" value={theirRef} onChange={e => setTheirRef(e.target.value)}
                     className="w-full border border-slate-300 rounded px-3 py-3 text-base font-mono" />
            </div>
            <div>
              <label htmlFor="speak-vehicle" className="block text-sm font-semibold mb-1">* {t('Vehicle')}</label>
              <input id="speak-vehicle" value={vehicleNo} onChange={e => setVehicleNo(e.target.value)}
                     className="w-full border border-slate-300 rounded px-3 py-3 text-base font-mono" />
            </div>
          </div>
        )}

        {needsPieces && (
          <div>
            <p className="text-sm font-semibold mb-1">{t('Which thaans?')} ({picked.length})</p>
            <div className="border border-slate-300 rounded divide-y max-h-56 overflow-y-auto">
              {pieces.length === 0 && (
                <p className="p-3 text-sm text-slate-500">
                  None of this challan's thaans are still in your custody.
                </p>
              )}
              {pieces.map(p => (
                <div key={p.piece_id} className="p-3 space-y-2">
                  <label className="flex items-center gap-3">
                    <input type="checkbox" className="w-5 h-5"
                           checked={!!chosen[p.barcode]}
                           onChange={e => setChosen(c => ({ ...c, [p.barcode]: e.target.checked }))} />
                    <span className="font-mono text-sm">{p.barcode}</span>
                    <span className="text-sm text-slate-500 ml-auto">
                      {Number(p.current_qty).toFixed(2)}
                    </span>
                  </label>
                  {chosen[p.barcode] && kind === 'shortage' && (
                    <label className="block text-sm">
                      <span className="font-semibold">{t('Short quantity')}</span>
                      <input aria-label={`${t('Short quantity')} ${p.barcode}`} type="number" min="0.01"
                        max={Number(p.current_qty)} step="0.01" value={quantities[p.barcode] ?? ''}
                        onChange={e => setQuantities(q => ({ ...q, [p.barcode]: e.target.value }))}
                        className="mt-1 w-full border border-slate-300 rounded px-3 py-2 text-base" />
                    </label>
                  )}
                  {chosen[p.barcode] && kind === 'rejection' && (
                    <label className="block text-sm">
                      <span className="font-semibold">{t('Reason for rejection')}</span>
                      <input aria-label={`${t('Reason for rejection')} ${p.barcode}`}
                        value={reasons[p.barcode] ?? ''}
                        onChange={e => setReasons(r => ({ ...r, [p.barcode]: e.target.value }))}
                        className="mt-1 w-full border border-slate-300 rounded px-3 py-2 text-base" />
                    </label>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        <div>
          <label htmlFor="speak-note" className="block text-sm font-semibold mb-1">
            {t('Anything to add')}
          </label>
          <textarea id="speak-note" value={note} onChange={e => setNote(e.target.value)}
                    rows={2} maxLength={500}
                    className="w-full border border-slate-300 rounded px-3 py-2 text-base" />
        </div>

        <button onClick={send} disabled={!ready || busy}
                className="w-full bg-blue-800 text-white font-bold rounded py-3 text-base disabled:opacity-50">
          {busy ? t('Sending…') : t('Send to the mill')}
        </button>
        <p className="text-xs text-slate-500 text-center">
          {t('This tells the mill. It does not move stock — they confirm it at their end.')}
        </p>
      </div>
    </div>
  );
};

const LanguageSelect: React.FC<{
  lang: Lang; setLang: (lang: Lang) => void; dark?: boolean;
}> = ({ lang, setLang, dark = false }) => (
  <select aria-label="Language" value={lang} onChange={e => setLang(e.target.value as Lang)}
    className={`rounded border px-2 py-2 text-sm ${
      dark ? 'border-blue-500 bg-blue-950 text-white' : 'border-slate-300 bg-white text-slate-800'
    }`}>
    {LANGUAGES.map(language => (
      <option key={language.code} value={language.code}>{language.label}</option>
    ))}
  </select>
);

const TranslationNotice: React.FC<{ text: string }> = ({ text }) => (
  <p className="bg-amber-50 border-b border-amber-300 text-amber-950 px-4 py-2 text-xs">
    {text}
  </p>
);
