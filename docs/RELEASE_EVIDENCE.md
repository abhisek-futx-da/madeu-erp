# Release Evidence — 22 August 2026

## Status

**Code-ready for controlled-pilot evaluation; not approved for statutory filing
or broad production rollout.** This is a local, reproducible test snapshot,
not a CA opinion, a mill acceptance, or a government integration result.

## What was verified from a clean database build

- 40 schema migrations applied and recorded.
- 14 database invariants passed.
- 241 server tests passed, including tenant isolation, concurrent scans and
  numbering, double-entry balancing, GST calculation, returns, cancellation,
  physical stock count, and maker-checker approvals.
- 63 frontend tests passed; the frontend typecheck and production build passed.
- The API and web container images built successfully.
- Browser sessions use HttpOnly, SameSite=Strict cookies; the web application
  does not persist an access token in browser storage, and logout revokes a
  replayed session as well as clearing the cookie.
- The year-volume harness met every defined query budget with 150,000 pieces,
  465,000 movement records, 3,000 invoices, and 10,500 invoice lines.

## Important lifecycle controls now present

- Grey, dyeing, customer returns, stock-count variance, and write-offs wait
  for an independent approver whenever the tenant’s rule requires it.
- While held, these documents move neither pieces nor ledger balances.
- Return values and customer-return tax are derived from recorded stock and
  the original invoice; operator-entered rates do not decide the books.
- Cancellation reverses posted vouchers and piece movements. For a document
  still awaiting approval, cancellation deletes its held voucher and records a
  cancellation event rather than leaving a stale proposal behind.
- Customer-return cancellation also cancels its linked GST credit note, so the
  register and GSTR-3B calculation return to their pre-return value.

## Do not claim these as complete

1. **CA validation:** treatment, reports, master data, opening migration, and
   the mill’s actual facts require written CA review.
2. **Live GSP/IRP/E-way:** no sandbox or production credential/provider round
   trip is proven by this evidence.
3. **Mill-floor proof:** barcode hardware, network loss, print output, staff
   workflow, and daily reconciliation require a controlled live pilot.
4. **GSTR-1 edge cases:** the product exposes the registered-recipient
   credit/debit-note register; unregistered/export classification must be
   agreed with the CA before filing.
5. **Release governance:** the reviewed source is now in local Git and tagged
   as a pilot release candidate. Before the CA review, push that exact tag to
   an access-controlled remote repository and preserve a second, independent
   backup; a laptop-only history is not sufficient business continuity.

The controlled-pilot routine, CA questions, and live-integration conditions are
in `CA_REVIEW_AND_MILL_PILOT.md` and `GSP_IRP_READINESS.md`.
