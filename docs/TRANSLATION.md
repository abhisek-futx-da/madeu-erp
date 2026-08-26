# Hindi and Gujarati translation

The process-house portal has an English-first Hindi and Gujarati catalog in
`link-erp/src/lib/i18n.ts`. English is always the fallback: a missing entry
shows usable English, never an internal translation key or an empty control.
The chosen language is stored only in the browser and the document `lang`
attribute changes with it for screen readers.

## What is translated now

- portal sign-in and sign-out;
- challan, thaan and declaration navigation;
- custody, expected-return, shortage, rejection and return-dispatch forms;
- status labels, empty states and the warning that declarations do not move
  stock.

This is the first operational pass, intentionally focused on the external
process-house user and their phone workflow. The mill application continues to
fall back to English until each floor workflow is reviewed with its operators.

## Native-speaker review gate

Hindi and Gujarati are deliberately marked `reviewed: false`. Do not remove
the on-screen warning or mark a language reviewed until a native speaker who
knows textile trade vocabulary has checked every catalog entry on a phone.

For each language:

1. ask a process-house dispatch user to sign in, identify their challans and
   thaans, acknowledge custody, report a shortage, report a rejection and file
   a return dispatch;
2. record any term they hesitate over, especially *thaan*, off-shade,
   short-delivery, challan and process house;
3. update the catalog and rerun the portal tests;
4. record reviewer name, date and accepted wording in the pilot evidence;
5. only then set that language's `reviewed` flag to `true`.

Adding another string is intentionally simple: use its English UI text as the
catalog key, add Hindi and Gujarati values, and keep the English fallback. Do
not invent a silent machine-translation pipeline for statutory or accounting
language.
