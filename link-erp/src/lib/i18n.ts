import { useEffect, useState } from 'react';

/**
 * Translation, without a library.
 *
 * The people who enter the most data into this system — the storekeeper on the
 * godown floor, the dispatch desk at a dyeing house — read Hindi or Gujarati
 * first. An i18n framework would be a production dependency and a build step
 * for what is, at this size, a lookup table and a `lang` attribute.
 *
 * Two rules keep this honest.
 *
 * A missing key renders the English text, never a blank or a raw key. A
 * half-translated screen is usable; a screen full of `portal.challans` is not.
 *
 * A language is marked `reviewed` only when a native speaker who knows the
 * trade has actually read it. Until then the interface says so, in that
 * language, every time it is used. Machine-plausible Hindi is not the same as
 * the word a Bhiwandi storekeeper uses for a roll of cloth, and quietly
 * shipping the wrong one is worse than shipping English.
 */

export type Lang = 'en' | 'hi' | 'gu';

export const LANGUAGES: { code: Lang; label: string; reviewed: boolean }[] = [
  { code: 'en', label: 'English', reviewed: true },
  // Not reviewed: see docs/TRANSLATION.md before turning either of these on for
  // a real mill. The trade vocabulary is the part that needs a person.
  { code: 'hi', label: 'हिन्दी', reviewed: false },
  { code: 'gu', label: 'ગુજરાતી', reviewed: false }
];

const STORAGE_KEY = 'link-erp:lang';

/** English is the key *and* the fallback, so an untranslated string still reads. */
type Catalog = Record<string, string>;

const hi: Catalog = {
  'Process House Portal': 'प्रोसेस हाउस पोर्टल',
  'Goods you are holding, and what you want to tell the mill.':
    'आपके पास रखा माल, और जो आप मिल को बताना चाहते हैं।',
  Email: 'ईमेल',
  Password: 'पासवर्ड',
  'Sign in': 'साइन इन',
  'Signing in…': 'साइन इन हो रहा है…',
  'Sign out': 'साइन आउट',
  'sign in failed': 'साइन इन नहीं हो सका',
  Challans: 'चालान',
  Thaans: 'थान',
  'What I told the mill': 'मैंने मिल को क्या बताया',
  'Tell the mill something': 'मिल को कुछ बताएं',
  'The mill has not sent you anything yet.': 'मिल ने अभी तक कुछ नहीं भेजा है।',
  'You are not holding any thaans right now.': 'इस समय आपके पास कोई थान नहीं है।',
  'You have not told the mill anything yet.': 'आपने अभी तक मिल को कुछ नहीं बताया है।',
  Received: 'मिल गया',
  'Not confirmed': 'पुष्टि नहीं हुई',
  'We have received these goods': 'यह माल हमें मिल गया है',
  'We will return them by a date': 'हम इसे इस तारीख तक वापस भेजेंगे',
  'Fewer arrived than the challan says': 'चालान से कम माल आया है',
  'Some are damaged or off-shade': 'कुछ खराब हैं या शेड नहीं मिला',
  'We have sent them back': 'हमने वापस भेज दिया है',
  'What do you want to say?': 'आप क्या बताना चाहते हैं?',
  'Expected return date': 'वापसी की संभावित तारीख',
  'Your challan': 'आपका चालान',
  Vehicle: 'गाड़ी',
  'Which thaans?': 'कौन से थान?',
  'Short quantity': 'कम मात्रा',
  'Reason for rejection': 'रिजेक्शन का कारण',
  'Anything to add': 'और कुछ कहना है',
  'Send to the mill': 'मिल को भेजें',
  'Sent to the mill': 'मिल को भेज दिया',
  'Sending…': 'भेजा जा रहा है…',
  Close: 'बंद करें',
  'This tells the mill. It does not move stock — they confirm it at their end.':
    'यह मिल को सूचना देता है। इससे स्टॉक नहीं बदलता — पुष्टि वे अपनी ओर से करते हैं।',
  'Waiting for the mill': 'मिल के जवाब का इंतज़ार',
  Accepted: 'स्वीकार',
  'Not accepted': 'स्वीकार नहीं',
  Mill: 'मिल',
  'Loading…': 'लोड हो रहा है…',
  'This translation has not been checked by a native speaker yet.':
    'इस अनुवाद की जाँच अभी किसी स्थानीय भाषी ने नहीं की है।',
  // --------------------------------------------------- the godown floor --
  // The screens a storekeeper uses all day. Office and accounts screens stay
  // in English on purpose: the people on them read English, and a
  // half-translated trial balance helps nobody.
  'Grey Inward (Barcoding)': 'ग्रे आवक (बारकोडिंग)',
  'Issue To Dyeing (Job Order Challan)': 'डाइंग को इशू (जॉब ऑर्डर चालान)',
  'Grey Return to Weaver': 'बुनकर को ग्रे वापस',
  'Defective Return to Process House': 'प्रोसेस हाउस को खराब माल वापस',
  'Customer Return': 'ग्राहक वापसी',
  'Write-off / Damage': 'राइट-ऑफ / नुकसान',
  'Dispatch / Delivery Challan': 'डिस्पैच / डिलीवरी चालान',
  'Cut / Pack': 'कट / पैक',
  'Receive From Dyeing': 'डाइंग से माल लें',
  'Physical Stock Count': 'भौतिक स्टॉक गिनती',
  Weaver: 'बुनकर',
  'Process House': 'प्रोसेस हाउस',
  Customer: 'ग्राहक',
  Barcode: 'बारकोड',
  Quality: 'क्वालिटी',
  Quantity: 'मात्रा',
  Amount: 'रकम',
  Rate: 'भाव',
  Lot: 'लॉट',
  Rack: 'रैक',
  Grade: 'ग्रेड',
  Metres: 'मीटर',
  Document: 'दस्तावेज़',
  Reason: 'कारण',
  'Pick from stock': 'स्टॉक से चुनें',
  'scan or type, then Enter': 'स्कैन करें या लिखें, फिर Enter',
  'quality, lot, rack or barcode': 'क्वालिटी, लॉट, रैक या बारकोड',
  'e.g. defect, damage, wrong colour': 'जैसे खराबी, नुकसान, गलत रंग',
  'Nothing has happened to this thaan yet.': 'इस थान के साथ अभी कुछ नहीं हुआ है।',
  'Journey of ': 'इस थान का सफर: ',
  'From → to': 'कहाँ से → कहाँ',
  Save: 'सेव करें',
  Print: 'प्रिंट',
  Remove: 'हटाएँ',
  Refresh: 'फिर लोड करें',
  'Post lot receipt': 'लॉट रसीद पोस्ट करें',
  'Add thaan': 'थान जोड़ें',
  'New barcode': 'नया बारकोड',
  'Against challan': 'किस चालान के सामने',
  'Their challan no.': 'उनका चालान नंबर',
  Shrinkage: 'श्रिंकेज',
  Sent: 'भेजा',
  Back: 'वापस आया',
  'Job work': 'जॉब वर्क',
  Offline: 'ऑफलाइन',
  'Saved on this phone; it will go up when the signal returns.':
    'इस फोन में सेव हुआ; सिग्नल आते ही भेज दिया जाएगा।'
};

const gu: Catalog = {
  'Process House Portal': 'પ્રોસેસ હાઉસ પોર્ટલ',
  'Goods you are holding, and what you want to tell the mill.':
    'તમારી પાસે રહેલો માલ, અને તમે મિલને શું જણાવવા માંગો છો.',
  Email: 'ઈમેલ',
  Password: 'પાસવર્ડ',
  'Sign in': 'સાઇન ઇન',
  'Signing in…': 'સાઇન ઇન થઈ રહ્યું છે…',
  'Sign out': 'સાઇન આઉટ',
  'sign in failed': 'સાઇન ઇન થઈ શક્યું નહીં',
  Challans: 'ચલણ',
  Thaans: 'થાન',
  'What I told the mill': 'મેં મિલને શું જણાવ્યું',
  'Tell the mill something': 'મિલને કંઈક જણાવો',
  'The mill has not sent you anything yet.': 'મિલે હજી સુધી કંઈ મોકલ્યું નથી.',
  'You are not holding any thaans right now.': 'અત્યારે તમારી પાસે કોઈ થાન નથી.',
  'You have not told the mill anything yet.': 'તમે હજી સુધી મિલને કંઈ જણાવ્યું નથી.',
  Received: 'મળી ગયું',
  'Not confirmed': 'પુષ્ટિ થઈ નથી',
  'We have received these goods': 'આ માલ અમને મળી ગયો છે',
  'We will return them by a date': 'અમે તે આ તારીખ સુધીમાં પરત મોકલીશું',
  'Fewer arrived than the challan says': 'ચલણ કરતાં ઓછો માલ આવ્યો છે',
  'Some are damaged or off-shade': 'કેટલાક બગડેલા છે અથવા શેડ મળતો નથી',
  'We have sent them back': 'અમે પરત મોકલી દીધા છે',
  'What do you want to say?': 'તમે શું જણાવવા માંગો છો?',
  'Expected return date': 'પરત મોકલવાની સંભવિત તારીખ',
  'Your challan': 'તમારું ચલણ',
  Vehicle: 'વાહન',
  'Which thaans?': 'કયા થાન?',
  'Short quantity': 'ઓછી માત્રા',
  'Reason for rejection': 'રિજેક્ટ કરવાનું કારણ',
  'Anything to add': 'બીજું કંઈ કહેવું છે',
  'Send to the mill': 'મિલને મોકલો',
  'Sent to the mill': 'મિલને મોકલી દીધું',
  'Sending…': 'મોકલાઈ રહ્યું છે…',
  Close: 'બંધ કરો',
  'This tells the mill. It does not move stock — they confirm it at their end.':
    'આ મિલને જાણ કરે છે. તેનાથી સ્ટોક બદલાતો નથી — પુષ્ટિ તેઓ તેમની બાજુથી કરે છે.',
  'Waiting for the mill': 'મિલના જવાબની રાહ',
  Accepted: 'સ્વીકૃત',
  'Not accepted': 'સ્વીકૃત નથી',
  Mill: 'મિલ',
  'Loading…': 'લોડ થઈ રહ્યું છે…',
  'This translation has not been checked by a native speaker yet.':
    'આ અનુવાદ હજી સુધી કોઈ સ્થાનિક ભાષીએ ચકાસ્યો નથી.',
  // --------------------------------------------------- the godown floor --
  // The screens a storekeeper uses all day. Office and accounts screens stay
  // in English on purpose: the people on them read English, and a
  // half-translated trial balance helps nobody.
  'Grey Inward (Barcoding)': 'ગ્રે આવક (બારકોડિંગ)',
  'Issue To Dyeing (Job Order Challan)': 'ડાઇંગ માટે ઇશ્યુ (જોબ ઓર્ડર ચલણ)',
  'Grey Return to Weaver': 'વણકરને ગ્રે પરત',
  'Defective Return to Process House': 'પ્રોસેસ હાઉસને ખરાબ માલ પરત',
  'Customer Return': 'ગ્રાહક પરત',
  'Write-off / Damage': 'રાઇટ-ઓફ / નુકસાન',
  'Dispatch / Delivery Challan': 'ડિસ્પેચ / ડિલિવરી ચલણ',
  'Cut / Pack': 'કટ / પેક',
  'Receive From Dyeing': 'ડાઇંગમાંથી માલ લો',
  'Physical Stock Count': 'ભૌતિક સ્ટોક ગણતરી',
  Weaver: 'વણકર',
  'Process House': 'પ્રોસેસ હાઉસ',
  Customer: 'ગ્રાહક',
  Barcode: 'બારકોડ',
  Quality: 'ક્વોલિટી',
  Quantity: 'જથ્થો',
  Amount: 'રકમ',
  Rate: 'ભાવ',
  Lot: 'લોટ',
  Rack: 'રેક',
  Grade: 'ગ્રેડ',
  Metres: 'મીટર',
  Document: 'દસ્તાવેજ',
  Reason: 'કારણ',
  'Pick from stock': 'સ્ટોકમાંથી પસંદ કરો',
  'scan or type, then Enter': 'સ્કેન કરો અથવા લખો, પછી Enter',
  'quality, lot, rack or barcode': 'ક્વોલિટી, લોટ, રેક કે બારકોડ',
  'e.g. defect, damage, wrong colour': 'દા.ત. ખામી, નુકસાન, ખોટો રંગ',
  'Nothing has happened to this thaan yet.': 'આ થાન સાથે હજી કંઈ થયું નથી.',
  'Journey of ': 'આ થાનની સફર: ',
  'From → to': 'ક્યાંથી → ક્યાં',
  Save: 'સાચવો',
  Print: 'પ્રિન્ટ',
  Remove: 'કાઢી નાખો',
  Refresh: 'ફરી લોડ કરો',
  'Post lot receipt': 'લોટ રસીદ પોસ્ટ કરો',
  'Add thaan': 'થાન ઉમેરો',
  'New barcode': 'નવો બારકોડ',
  'Against challan': 'કયા ચલણ સામે',
  'Their challan no.': 'તેમનો ચલણ નંબર',
  Shrinkage: 'શ્રિન્કેજ',
  Sent: 'મોકલ્યું',
  Back: 'પરત આવ્યું',
  'Job work': 'જોબ વર્ક',
  Offline: 'ઓફલાઇન',
  'Saved on this phone; it will go up when the signal returns.':
    'આ ફોનમાં સાચવ્યું; સિગ્નલ આવતાં જ મોકલાશે.'
};

const CATALOGS: Record<Lang, Catalog> = { en: {}, hi, gu };

export function readLang(): Lang {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'hi' || stored === 'gu' || stored === 'en') return stored;
  } catch { /* a locked-down browser simply gets English */ }
  return 'en';
}

export function writeLang(lang: Lang) {
  try { localStorage.setItem(STORAGE_KEY, lang); } catch { /* ignore */ }
  applyLang(lang);
  window.dispatchEvent(new CustomEvent('erp-lang', { detail: lang }));
}

/** Screen readers and browser hyphenation both need the document to say this. */
export function applyLang(lang: Lang) {
  if (typeof document !== 'undefined') document.documentElement.lang = lang;
}

/**
 * `english` is the key. Interpolation is `{name}`, deliberately the simplest
 * thing that works — nothing here needs plurals or gender yet, and inventing a
 * message format nobody has asked for is how a lookup table becomes a library.
 */
export function translate(lang: Lang, english: string, vars?: Record<string, string | number>) {
  const text = CATALOGS[lang][english] ?? english;
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in vars ? String(vars[key]) : whole);
}

export function useLang() {
  const [lang, setLang] = useState<Lang>(readLang);

  useEffect(() => {
    applyLang(lang);
    const sync = (e: Event) => setLang((e as CustomEvent<Lang>).detail);
    window.addEventListener('erp-lang', sync);
    return () => window.removeEventListener('erp-lang', sync);
  }, [lang]);

  return {
    lang,
    setLang: (next: Lang) => { setLang(next); writeLang(next); },
    reviewed: LANGUAGES.find(l => l.code === lang)?.reviewed ?? true,
    t: (english: string, vars?: Record<string, string | number>) =>
      translate(lang, english, vars)
  };
}

/** How much of each catalog exists, which is the honest measure of coverage. */
export const coverage = (lang: Lang) => Object.keys(CATALOGS[lang]).length;
