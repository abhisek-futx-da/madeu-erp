import React from 'react';
import { Languages } from 'lucide-react';
import { LANGUAGES, useLang, type Lang } from '../lib/i18n';

/**
 * The floor reads Hindi or Gujarati first; the office reads English. One
 * switcher in the shell rather than a setting buried in a preferences screen,
 * because the person who needs it is holding a scanner, not browsing menus.
 *
 * An unreviewed language says so, in that language, every time it is used. A
 * storekeeper who can see the warning can tell us which word is wrong; one who
 * cannot will simply trust a machine translation of his own trade.
 */
export const LanguageSwitcher: React.FC = () => {
  const { lang, setLang, reviewed, t } = useLang();

  return (
    <>
      <label className="flex items-center gap-1" title="Language / भाषा / ભાષા">
        <Languages className="h-3.5 w-3.5 text-blue-900" aria-hidden />
        <span className="sr-only">Language</span>
        <select aria-label="Language" className="erp-input min-h-11 py-0.5"
          value={lang} onChange={e => setLang(e.target.value as Lang)}>
          {LANGUAGES.map(l => (
            <option key={l.code} value={l.code}>{l.label}</option>
          ))}
        </select>
      </label>
      {!reviewed && (
        <span role="status"
          className="max-w-56 truncate rounded border border-amber-400 bg-amber-100 px-2 py-0.5 text-amber-900"
          title={t('This translation has not been checked by a native speaker yet.')}>
          {t('This translation has not been checked by a native speaker yet.')}
        </span>
      )}
    </>
  );
};
