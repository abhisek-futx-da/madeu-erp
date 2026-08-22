# CA Review and Controlled Mill Pilot Gate

This is a release gate, not a marketing brochure. Passing it means the product
may enter one controlled pilot. It does **not** mean statutory compliance,
production IRP filing, or a CA opinion has been obtained.

## Code evidence available for review

- Clean database rebuild from all migrations; 14 database invariants pass.
- 241 server tests pass: piece traceability, double entry, stock valuation,
  payments, cancellation, tenant isolation, concurrency, GST calculations,
  e-invoice/e-way payload validation, physical counts, return flows, and
  maker-checker approvals.
- 65 frontend tests, frontend type-check, production build, API image build,
  and web image build pass.
- The year-volume query harness passes its defined budgets.
- Customer, grey, and dyeing returns are held until an independent accountant
  approves. A held document changes neither stock nor the ledger.
- A customer return derives its quantity, price, tax, and credit note from the
  original invoice. Its cancellation reverses the voucher, restores the piece,
  cancels the linked GST note, and restores GSTR-1/GSTR-3B figures.
- Each held financial exception records its submission, approval/rejection, or
  cancellation in the approval history. Cancelling before approval also drops
  the held voucher; it cannot be posted later by mistake.

## CA review pack to supply

1. A copy of the test evidence above, exact build version, and the migration
   list.
2. A trial balance, P&L, balance sheet, stock valuation, receivable/payable
   ageing, cash book, GSTR-1 B2B, GSTR-1 credit/debit-note register, GSTR-3B
   outward, GSTR-2B reconciliation, ITC-04, and TDS summary for one sample
   period.
3. Ten real but redacted examples: grey purchase, job-work issue/receipt,
   sale, customer return, supplier return, process-house return, write-off,
   receipt, payment, and stock-count variance.
4. The mill's chart of accounts, opening balances, GST registrations, HSN/rate
   masters, party GSTINs, financial-year cut-off, approval limits, and physical
   stock-opening method.

## Questions the CA must answer in writing

- Are opening stock value and opening ledger balances reconciled, and what is
  the approved conversion method for legacy stock?
- Are the selected HSNs, GST rates, place-of-supply rules, RCM treatment,
  TDS treatment, and job-work treatment correct for this mill's transactions?
- Are the report columns and period totals sufficient for the CA's GSTR-1,
  GSTR-3B, ITC-04, books, and audit workflow?
- Are return, credit-note, debit-note, cancellation, and amendment policies
  correct for filed and unfiled periods?
- Which reports, approvals, retention periods, and audit exports are required
  before production sign-off?

No CA question may be answered by changing live code during the review. Record
the decision, approve it, then apply a tested change in a new release.

## Controlled pilot boundary

Run one legal entity, one godown, one financial year, and a named pilot team:
owner, accounts checker, store operator, sales operator, and process-house
contact. Start with a bounded set of live lots and reconcile every day.

### Daily acceptance routine

1. Open with the prior day's trial balance, stock valuation, receivables,
   payables, and goods at process houses.
2. Process real grey inward, job-work issue/receipt, cut/pack, dispatch,
   invoice, receipt/payment, and any exception through the normal screens.
3. Approve every held return, write-off, and stock-count document with a
   different person.
4. Count one defined rack; investigate every variance before approval.
5. Reconcile the movement log to stock, vouchers to the trial balance, and
   GST reports to the day's issued documents. Record any mismatch as a pilot
   defect, not an operator workaround.
6. Back up the data and prove one restore into a non-production environment.

## Pilot exit criteria

- Ten consecutive working days with no unexplained stock, voucher, or GST
  reconciliation difference.
- CA accepts the reports and treatment for the pilot's actual transactions.
- A restore drill, role/access review, and exception-approval review pass.
- Live GSP/IRP tests pass separately before enabling live statutory submission.

## Non-negotiable external gates

- No statement of GST compliance before a CA reviews this mill's facts.
- No live e-invoice, e-way bill, or return filing before GSP/IRP sandbox and
  production credentials have passed their own acceptance tests.
- No broad rollout before a successful controlled pilot and a documented
  cutover/rollback plan.
