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
  'Sign In': 'साइन इन',
  'Verify & Sign In': 'जाँच कर साइन इन करें',
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
    'इस फोन में सेव हुआ; सिग्नल आते ही भेज दिया जाएगा।',

  // The menu. A storekeeper reads this before anything else, so a half-Hindi
  // bar is worse than either extreme. Statutory names (GSTR-1, HSN, TDS) stay
  // as they are: that is what the trade and the department both call them.
  Home: 'होम', Masters: 'मास्टर', Editions: 'एडिशन', Inventory: 'स्टॉक',
  Accounts: 'अकाउंट', Reports: 'रिपोर्ट',
  Dashboard: 'डैशबोर्ड',
  'Global Search': 'पूरे सिस्टम में खोजें',
  Approvals: 'मंजूरी',
  'My Password': 'मेरा पासवर्ड',
  'Company Setup & Controls': 'कंपनी सेटअप और कंट्रोल',
  'Go-Live Readiness': 'शुरू करने की तैयारी',
  'Customization & Integration Studio': 'कस्टमाइज़ेशन और इंटीग्रेशन स्टूडियो',
  'Barcode History': 'बारकोड हिस्ट्री',
  'Audit Trail': 'ऑडिट ट्रेल',
  'Ledger Accounts': 'लेजर खाते',
  'Quality Master': 'क्वालिटी मास्टर',
  'Grade Master': 'ग्रेड मास्टर',
  'HSN / SAC Master': 'HSN / SAC मास्टर',
  'Unit Master': 'यूनिट मास्टर',
  'Width Master': 'चौड़ाई मास्टर',
  'Rack Master': 'रैक मास्टर',
  'Division Master': 'डिवीजन मास्टर',
  'Customer Names For Our Cloth': 'हमारे कपड़े के ग्राहक नाम',
  'Bank Accounts': 'बैंक खाते',
  'People & Access': 'लोग और एक्सेस',
  'Data Migration & Onboarding': 'डेटा माइग्रेशन और शुरुआत',
  'Weaving Edition': 'वीविंग एडिशन',
  'Dyeing Edition': 'डाइंग एडिशन',
  'Exports Edition': 'एक्सपोर्ट एडिशन',
  'Logistics Edition': 'लॉजिस्टिक्स एडिशन',
  'Garments Edition': 'गारमेंट एडिशन',
  'Grey Purchase Orders': 'ग्रे खरीद ऑर्डर',
  'Finish Sales Orders': 'फिनिश बिक्री ऑर्डर',
  'Issue To Dyeing': 'डाइंग को इशू',
  'Receive By Lot (No Barcodes Back)': 'लॉट से माल लें (बारकोड वापस नहीं)',
  'Dyeing Reprocess / Rework': 'डाइंग रीप्रोसेस / दोबारा काम',
  'Grey Return To Weaver': 'बुनकर को ग्रे वापस',
  'Dyeing Return To Process House': 'प्रोसेस हाउस को माल वापस',
  'Split / Join Thaan': 'थान तोड़ें / जोड़ें',
  'Process Houses': 'प्रोसेस हाउस',
  'Offline Scan Queue': 'ऑफलाइन स्कैन कतार',
  'Godown Stock Transfers': 'गोदाम स्टॉक ट्रांसफर',
  'Delivery Challans (Rule 55)': 'डिलीवरी चालान (नियम 55)',
  'Barcode Labels': 'बारकोड लेबल',
  Dispatch: 'डिस्पैच',
  'Customer Packing Lists': 'ग्राहक पैकिंग लिस्ट',
  'Receipts & Payments': 'रसीद और भुगतान',
  'Bank Reconciliation': 'बैंक मिलान',
  'Mill Integrations & Tally': 'मिल इंटीग्रेशन और Tally',
  'Tax Invoices': 'टैक्स इनवॉइस',
  'Purchase Invoices': 'खरीद बिल',
  'Credit / Debit Notes': 'क्रेडिट / डेबिट नोट',
  'Sales Register': 'बिक्री रजिस्टर',
  'Purchase Register': 'खरीद रजिस्टर',
  'Day Book': 'रोजनामचा',
  'Ledger (Any Account)': 'लेजर (कोई भी खाता)',
  'Order Lines With Specification': 'ऑर्डर लाइन, विवरण सहित',
  'Cash & Bank Book': 'रोकड़ और बैंक बुक',
  'Contra (Cash / Bank Transfer)': 'कॉन्ट्रा (रोकड़ / बैंक ट्रांसफर)',
  'Trading Account': 'व्यापार खाता',
  'Profit & Loss': 'लाभ-हानि',
  'Balance Sheet': 'बैलेंस शीट',
  'Trial Balance': 'ट्रायल बैलेंस',
  'Trial Balance By Group': 'ग्रुप अनुसार ट्रायल बैलेंस',
  'Party Statement': 'पार्टी स्टेटमेंट',
  'Receivable Ageing': 'वसूली की उम्र',
  'Interest On Overdue (Vyaj)': 'बकाया पर ब्याज',
  'Email Outbox': 'ईमेल आउटबॉक्स',
  'Outstanding Receivables': 'बकाया वसूली',
  'Outstanding Payables': 'बकाया देनदारी',
  'Party Balances': 'पार्टी बैलेंस',
  'TDS Deducted': 'काटा गया TDS',
  'Year End Close': 'साल का समापन',
  'GSTR-1 Credit / Debit Notes': 'GSTR-1 क्रेडिट / डेबिट नोट',
  'GSTR-1 HSN Summary': 'GSTR-1 HSN सारांश',
  'GSTR-3B Outward': 'GSTR-3B बाहरी सप्लाई',
  'ITC-04 (job work)': 'ITC-04 (जॉब वर्क)',
  'E-Way Bills': 'ई-वे बिल',
  'Input Tax Credit': 'इनपुट टैक्स क्रेडिट',
  'Net GST Liability': 'कुल जीएसटी देनदारी',
  'E-invoice Queue': 'ई-इनवॉइस कतार',
  'GSTR-2B Reconciliation': 'GSTR-2B मिलान',
  'Stock Valuation': 'स्टॉक मूल्यांकन',
  'Stock By Godown': 'गोदाम अनुसार स्टॉक',
  'Cash Book': 'रोकड़ बही',
  'Stock Summary': 'स्टॉक सारांश',
  'Process Stock': 'प्रोसेस में स्टॉक',
  'PO Pending': 'बाकी खरीद ऑर्डर',
  'Margin by Quality': 'क्वालिटी अनुसार मार्जिन',
  'Weaver Scorecard': 'बुनकर स्कोरकार्ड',
  'Process House Scorecard': 'प्रोसेस हाउस स्कोरकार्ड',

  // The shell around every screen.
  Menu: 'मेन्यू', 'Close menu': 'मेन्यू बंद करें',
  Active: 'चालू', Language: 'भाषा', Connected: 'जुड़ा है',
  'Primary modules': 'मुख्य मॉड्यूल',

  // The report frame, which every report on the system draws.
  Export: 'एक्सपोर्ट', Excel: 'एक्सेल',
  CSV: 'CSV', 'Print PDF': 'PDF प्रिंट', Previous: 'पिछला', Next: 'अगला',
  Delete: 'हटाएं', 'Save current': 'यह लेआउट सेव करें',
  'Search the whole report...': 'पूरी रिपोर्ट में खोजें...',
  'My saved reports': 'मेरी सेव की हुई रिपोर्ट',
  'Choose saved report': 'सेव की हुई रिपोर्ट चुनें',
  'Name this filter and layout': 'इस फिल्टर और लेआउट का नाम',
  'Position as on today — no date range applies':
    'आज की स्थिति — तारीख की सीमा लागू नहीं',
  '{n} row': '{n} पंक्ति', '{n} rows': '{n} पंक्तियां',
  '{from}–{to} of {total}': '{total} में से {from}–{to}',
  From: 'से', To: 'तक', Total: 'कुल',
  'No completed documents match this report yet.':
    'इस रिपोर्ट से मेल खाता कोई पूरा दस्तावेज़ अभी नहीं है।',

  // Column headings and buttons the report frame looks up. A label with no
  // entry here still renders its English, which is the point of the fallback.
  Stage: 'स्थिति', Pcs: 'नग', 'Qty (Mtr)': 'मात्रा (मीटर)', Qty: 'मात्रा',
  Date: 'तारीख', Party: 'पार्टी', Status: 'स्थिति', Value: 'कीमत',
  Pieces: 'नग', Columns: 'कॉलम', New: 'नया', Reset: 'रीसेट', Find: 'खोजें',
  Kg: 'किलो', Racks: 'रैक', Code: 'कोड', Name: 'नाम',
  'Open dashboard': 'डैशबोर्ड खोलें',
  'Record grey inward': 'ग्रे आवक दर्ज करें',
  'No stock movement has been recorded yet.': 'अभी तक कोई स्टॉक हलचल दर्ज नहीं हुई है।'
};

const gu: Catalog = {
  'Process House Portal': 'પ્રોસેસ હાઉસ પોર્ટલ',
  'Goods you are holding, and what you want to tell the mill.':
    'તમારી પાસે રહેલો માલ, અને તમે મિલને શું જણાવવા માંગો છો.',
  Email: 'ઈમેલ',
  Password: 'પાસવર્ડ',
  'Sign in': 'સાઇન ઇન',
  'Sign In': 'સાઇન ઇન',
  'Verify & Sign In': 'ચકાસીને સાઇન ઇન કરો',
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
    'આ ફોનમાં સાચવ્યું; સિગ્નલ આવતાં જ મોકલાશે.',

  Home: 'હોમ', Masters: 'માસ્ટર', Editions: 'એડિશન', Inventory: 'સ્ટોક',
  Accounts: 'એકાઉન્ટ', Reports: 'રિપોર્ટ',
  Dashboard: 'ડેશબોર્ડ',
  'Global Search': 'આખા સિસ્ટમમાં શોધો',
  Approvals: 'મંજૂરી',
  'My Password': 'મારો પાસવર્ડ',
  'Company Setup & Controls': 'કંપની સેટઅપ અને કંટ્રોલ',
  'Go-Live Readiness': 'શરૂ કરવાની તૈયારી',
  'Customization & Integration Studio': 'કસ્ટમાઇઝેશન અને ઇન્ટીગ્રેશન સ્ટુડિયો',
  'Barcode History': 'બારકોડ હિસ્ટ્રી',
  'Audit Trail': 'ઓડિટ ટ્રેલ',
  'Ledger Accounts': 'લેજર ખાતાં',
  'Quality Master': 'ક્વોલિટી માસ્ટર',
  'Grade Master': 'ગ્રેડ માસ્ટર',
  'HSN / SAC Master': 'HSN / SAC માસ્ટર',
  'Unit Master': 'યુનિટ માસ્ટર',
  'Width Master': 'પહોળાઈ માસ્ટર',
  'Rack Master': 'રેક માસ્ટર',
  'Division Master': 'ડિવિઝન માસ્ટર',
  'Customer Names For Our Cloth': 'આપણા કાપડનાં ગ્રાહક નામ',
  'Bank Accounts': 'બેંક ખાતાં',
  'People & Access': 'લોકો અને એક્સેસ',
  'Data Migration & Onboarding': 'ડેટા માઇગ્રેશન અને શરૂઆત',
  'Weaving Edition': 'વીવિંગ એડિશન',
  'Dyeing Edition': 'ડાઇંગ એડિશન',
  'Exports Edition': 'એક્સપોર્ટ એડિશન',
  'Logistics Edition': 'લોજિસ્ટિક્સ એડિશન',
  'Garments Edition': 'ગારમેન્ટ એડિશન',
  'Grey Purchase Orders': 'ગ્રે ખરીદ ઓર્ડર',
  'Finish Sales Orders': 'ફિનિશ વેચાણ ઓર્ડર',
  'Issue To Dyeing': 'ડાઇંગમાં ઇશ્યૂ',
  'Receive By Lot (No Barcodes Back)': 'લોટથી માલ લો (બારકોડ પાછા નહીં)',
  'Dyeing Reprocess / Rework': 'ડાઇંગ રીપ્રોસેસ / ફરી કામ',
  'Grey Return To Weaver': 'વણકરને ગ્રે પાછું',
  'Dyeing Return To Process House': 'પ્રોસેસ હાઉસને માલ પાછો',
  'Split / Join Thaan': 'થાન તોડો / જોડો',
  'Process Houses': 'પ્રોસેસ હાઉસ',
  'Offline Scan Queue': 'ઓફલાઇન સ્કેન કતાર',
  'Godown Stock Transfers': 'ગોડાઉન સ્ટોક ટ્રાન્સફર',
  'Delivery Challans (Rule 55)': 'ડિલિવરી ચલણ (નિયમ 55)',
  'Barcode Labels': 'બારકોડ લેબલ',
  Dispatch: 'ડિસ્પેચ',
  'Customer Packing Lists': 'ગ્રાહક પેકિંગ લિસ્ટ',
  'Receipts & Payments': 'રસીદ અને ચુકવણી',
  'Bank Reconciliation': 'બેંક મેળવણી',
  'Mill Integrations & Tally': 'મિલ ઇન્ટીગ્રેશન અને Tally',
  'Tax Invoices': 'ટેક્સ ઇન્વોઇસ',
  'Purchase Invoices': 'ખરીદ બિલ',
  'Credit / Debit Notes': 'ક્રેડિટ / ડેબિટ નોટ',
  'Sales Register': 'વેચાણ રજિસ્ટર',
  'Purchase Register': 'ખરીદ રજિસ્ટર',
  'Day Book': 'રોજમેળ',
  'Ledger (Any Account)': 'લેજર (કોઈ પણ ખાતું)',
  'Order Lines With Specification': 'ઓર્ડર લાઇન, વિગત સાથે',
  'Cash & Bank Book': 'રોકડ અને બેંક બુક',
  'Contra (Cash / Bank Transfer)': 'કોન્ટ્રા (રોકડ / બેંક ટ્રાન્સફર)',
  'Trading Account': 'વેપાર ખાતું',
  'Profit & Loss': 'નફો-નુકસાન',
  'Balance Sheet': 'બેલેન્સ શીટ',
  'Trial Balance': 'ટ્રાયલ બેલેન્સ',
  'Trial Balance By Group': 'ગ્રુપ પ્રમાણે ટ્રાયલ બેલેન્સ',
  'Party Statement': 'પાર્ટી સ્ટેટમેન્ટ',
  'Receivable Ageing': 'ઉઘરાણીની ઉંમર',
  'Interest On Overdue (Vyaj)': 'બાકી પર વ્યાજ',
  'Email Outbox': 'ઈમેલ આઉટબોક્સ',
  'Outstanding Receivables': 'બાકી ઉઘરાણી',
  'Outstanding Payables': 'બાકી ચૂકવણું',
  'Party Balances': 'પાર્ટી બેલેન્સ',
  'TDS Deducted': 'કાપેલો TDS',
  'Year End Close': 'વર્ષનું સમાપન',
  'GSTR-1 Credit / Debit Notes': 'GSTR-1 ક્રેડિટ / ડેબિટ નોટ',
  'GSTR-1 HSN Summary': 'GSTR-1 HSN સારાંશ',
  'GSTR-3B Outward': 'GSTR-3B બહારની સપ્લાય',
  'ITC-04 (job work)': 'ITC-04 (જોબ વર્ક)',
  'E-Way Bills': 'ઈ-વે બિલ',
  'Input Tax Credit': 'ઇનપુટ ટેક્સ ક્રેડિટ',
  'Net GST Liability': 'કુલ જીએસટી જવાબદારી',
  'E-invoice Queue': 'ઈ-ઇન્વોઇસ કતાર',
  'GSTR-2B Reconciliation': 'GSTR-2B મેળવણી',
  'Stock Valuation': 'સ્ટોક મૂલ્યાંકન',
  'Stock By Godown': 'ગોડાઉન પ્રમાણે સ્ટોક',
  'Cash Book': 'રોકડ મેળ',
  'Stock Summary': 'સ્ટોક સારાંશ',
  'Process Stock': 'પ્રોસેસમાં સ્ટોક',
  'PO Pending': 'બાકી ખરીદ ઓર્ડર',
  'Margin by Quality': 'ક્વોલિટી પ્રમાણે માર્જિન',
  'Weaver Scorecard': 'વણકર સ્કોરકાર્ડ',
  'Process House Scorecard': 'પ્રોસેસ હાઉસ સ્કોરકાર્ડ',

  Menu: 'મેનુ', 'Close menu': 'મેનુ બંધ કરો',
  Active: 'ચાલુ', Language: 'ભાષા', Connected: 'જોડાયેલ',
  'Primary modules': 'મુખ્ય મોડ્યુલ',

  Export: 'એક્સપોર્ટ', Excel: 'એક્સેલ',
  CSV: 'CSV', 'Print PDF': 'PDF પ્રિન્ટ', Previous: 'પાછલું', Next: 'આગળનું',
  Delete: 'કાઢી નાખો', 'Save current': 'આ લેઆઉટ સેવ કરો',
  'Search the whole report...': 'આખા રિપોર્ટમાં શોધો...',
  'My saved reports': 'મારા સેવ કરેલા રિપોર્ટ',
  'Choose saved report': 'સેવ કરેલો રિપોર્ટ પસંદ કરો',
  'Name this filter and layout': 'આ ફિલ્ટર અને લેઆઉટનું નામ',
  'Position as on today — no date range applies':
    'આજની સ્થિતિ — તારીખની મર્યાદા લાગુ નથી',
  '{n} row': '{n} હરોળ', '{n} rows': '{n} હરોળ',
  '{from}–{to} of {total}': '{total} માંથી {from}–{to}',
  From: 'થી', To: 'સુધી', Total: 'કુલ',
  'No completed documents match this report yet.':
    'આ રિપોર્ટ સાથે મેળ ખાતો કોઈ પૂરો દસ્તાવેજ હજી નથી.',

  Stage: 'સ્થિતિ', Pcs: 'નંગ', 'Qty (Mtr)': 'જથ્થો (મીટર)', Qty: 'જથ્થો',
  Date: 'તારીખ', Party: 'પાર્ટી', Status: 'સ્થિતિ', Value: 'કિંમત',
  Pieces: 'નંગ', Columns: 'કોલમ', New: 'નવું', Reset: 'રીસેટ', Find: 'શોધો',
  Kg: 'કિલો', Racks: 'રેક', Code: 'કોડ', Name: 'નામ',
  'Open dashboard': 'ડેશબોર્ડ ખોલો',
  'Record grey inward': 'ગ્રે આવક નોંધો',
  'No stock movement has been recorded yet.': 'હજી સુધી કોઈ સ્ટોક હલચલ નોંધાઈ નથી.'
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
