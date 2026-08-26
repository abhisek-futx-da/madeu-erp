# Release Evidence — 27 August 2026

**Local production-pilot candidate:** current working tree. Commit and sign an
immutable release tag after review; the older `v0.4.0-onboarding-rc1` tag does
not contain the commercial-foundation and production-operations additions.

## Status

**Software-ready for a controlled cloth-mill production pilot; not yet accepted
for statutory filing or broad rollout.** This is reproducible engineering
evidence, not a CA opinion, mill acceptance, or government-provider result.

## What was verified from a clean database build

- 51 schema migrations applied and recorded; the migration ledger exactly
  matches the migration files and every foreign key has a supporting index.
- 20 database invariants passed.
- 345 server tests passed with no skips, including tenant isolation, concurrent scans and
  numbering, double-entry balancing, GST calculation, returns, cancellation,
  physical stock count, reprocessing, purchase orders, sales-order allocation,
  packing lists, bank reconciliation, and maker-checker approvals.
- 104 frontend tests passed with no skips; the frontend typecheck and production
  build passed.
- The desktop/mobile browser gate passed every applicable case: accessible
  shell and forms, deep links, mobile navigation, and every owner module
  rendering without a browser crash or API 500.
- The complete local release pipeline passed 16/16 gates, including production
  dependency audits at high severity, upgrade rehearsal, restore drill, browser
  checks, and both container image builds.
- The API and web container images built successfully.
- The paired loopback hardware bridge passed its raw ZPL/TSPL validation,
  exact-origin/token protection, printer error, and scale parsing tests.
- Browser sessions use HttpOnly, SameSite=Strict cookies; the web application
  does not persist an access token in browser storage, and logout revokes a
  replayed session as well as clearing the cookie.
- General request throttling is an atomic PostgreSQL operation shared by API
  replicas. JWTs carry a signing-key ID, and a bounded previous-key list allows
  rotation without silently logging every user out.
- PostgreSQL numeric and int8 values outside JavaScript's safe integer boundary
  are rejected instead of rounded. Financial arithmetic remains in integer
  paise.
- The accessible desktop workspace keeps up to eight screens mounted, so a
  draft survives comparison with a ledger or report. Identical reads are
  deduplicated and briefly cached; financial writes invalidate the cache and
  are never optimistic.
- Owners can create, role-change, disable, reactivate, and reset staff access
  for their own company. Access is tenant-scoped, resets and removal invalidate
  old sessions, access events are append-only, and the last active owner cannot
  be disabled or demoted.
- The profile-gated real-mill bootstrap creates a clean legal entity atomically:
  named owner, system chart and posting ledgers, an open financial year,
  document series, standard units, and mandatory owner approval across all nine
  financial/stock exception classes. It
  creates no demo stock, parties, bank account, HSN/SAC, rates, TDS rule, or
  accounting transaction; its duplicate-setup rollback is tested.
- Migrations were exercised against a PostgreSQL server with no application
  source mounted, proving their checksums and ledger no longer depend on
  server-local file paths.
- A restore drill is automated: a fresh backup must restore into a separate
  database and pass migration, tenant, per-voucher double-entry, and piece-log
  drift checks. Older host tools automatically fall back to a matching official
  PostgreSQL client image. A printed warning cannot make this gate pass.
- A first-day dashboard guides a new mill through masters, grey inward,
  job-work issue/receipt, and dispatch/invoicing. Empty reports now explain
  which real document is missing and link to its workflow.
- The owner-only onboarding workbench imports ledgers, qualities, HSN/SAC
  codes, grades, units, widths, and racks from Excel-compatible CSV. It stages
  a preview, validates schema, duplicates and references, then applies the
  accepted rows once in a single transaction. Rejection reports and immutable
  batch history are retained. Opening books, bill-wise receivables/payables,
  and physical barcode stock are entered through a separate guarded cutover
  workflow, not through the master CSV importer.
- Tenant-wide operational search finds pieces/barcodes/lots, parties, purchase
  and sales orders, dispatches, sales and purchase invoices, payments, GST
  notes, e-way bills, and all edition documents, with ranked linked drilldown
  to the exact module.
- The year-volume harness met every defined query budget with 150,000 pieces,
  465,000 movement records, 3,000 invoices, and 10,500 invoice lines. The RLS
  stock-status path measured 23.0 ms against its 300 ms budget after a targeted
  partial-index correction and passed twice more on the same dataset.

## Mill-floor and commercial controls now present

- **Go-Live Readiness** gives the owner one cutover surface for company
  locations, balanced opening books, bill-wise legacy outstandings, and audited
  grey/finish opening stock. Each piece records barcode, quality, grade, lot,
  metres, kilograms, rack, stage, and carried value without inventing a purchase
  voucher. Opening stock and outstandings lock after the first posted voucher.
- Opening books, bill-wise receivables/payables, and physical barcode stock have
  Excel-compatible CSV templates and controlled import paths. Ledger/master
  references, duplicates, quantities, values, and file limits are validated;
  stock is staged for review and bill files post atomically after confirmation.
- PDF/JPEG/PNG evidence is retained against invoices, payments, opening-stock
  batches, and godown transfers. The server verifies actual file signatures,
  caps files at 5 MB, stores SHA-256 hashes, prevents duplicate live evidence,
  and records removal without deleting the bytes or append-only event trail.
- Report users can save private filter/column layouts and export exactly the
  filtered rows and currently visible columns.
- The shared platform adds typed custom fields to real masters, documents, and
  edition resources; reusable private or company reports over nine allow-listed sources, and
  integration pull feeds with one-time hashed keys, tenant-scoped subscriptions,
  idempotent delivery rows, acknowledgements, pausing and immediate rotation.
  Report values are bound parameters and integrations cannot configure server-
  side URLs. Definition/credential changes and business events remain audited.
- Five independently controlled edition packs now run beside the cloth-trading
  core: weaving, dyeing, exports, logistics, and garments. Their 46 validated
  operational workflows have per-financial-year numbering, permission-gated
  create/edit actions, guarded status transitions, immutable event history,
  attachments, custom fields, CSV registers, shared report/search visibility,
  and automatic create/status integration events. Typed resources connect the
  workflows to an append-only average-cost stock subledger. Material and cost
  lines calculate job cost; parent-document links retain process lineage; and
  owner-selected workflows require approval by someone other than their maker.
  Pausing one edition blocks new documents while preserving its existing record.
- Users carry an active business location and a live permission profile whose
  base role must match their membership. The active godown can be switched in
  the shell; new racks and operational custody stay location-scoped.
- **Godown Stock Transfers** scan or paste barcodes and move only custody and
  rack. Database guards preserve stage, quantity, weight, and value; reversal is
  allowed only while that transfer is still each piece's latest movement.
- The pre-pilot data gate refuses demo identities, missing MFA/password change,
  incomplete profiles/locations, unreconciled stock/openings/outstandings,
  missing approvals, and any company where live posting already began.

- Grey inward is scan-first and keyboard-operable, keeps an offline queue, can
  capture a paired scale, records gross/tare/net kilograms beside metres, and
  prices the receipt by either KGS or MTR without mixing the bases.
- Raw Code128 ZPL/TSPL reaches a paired local network/CUPS thermal printer; the
  same exact bytes download as a spool file when no bridge is configured.
- Metres and kilograms travel together through grey stock, dyeing issue,
  receipt, reprocess, movement history, GLM/GSM, valuation, labels, and packing.
- Receipt settlement records typed CD, quality/rate/shortage kapat and TDS in
  one transaction. Sales brokerage accrues first, is released to the broker
  only after full approved settlement, and supports audited owner forfeiture.
- Mixed/partial dyeing receipts reconcile to consolidated process-house bills
  by exact receipt line, never FIFO; over-allocation and cross-house matching
  are database-refused and cancellation releases the allocation.
- Tally XML exports active ledger masters and balanced posted vouchers. Tax
  invoices download as an invoice plus LR/packing PDF. The idempotent WhatsApp
  outbox supports customer/broker invoice copies, statement PDFs, payment
  reminders, retry backoff, and cancellation without claiming a send when the
  provider is absent.

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
- Dyeing receipt cancellation removes only that receipt's job-work value,
  restores process-house custody and quantity, and permits one corrected
  receipt without double capitalisation. A live replacement receipt blocks
  cancellation of its source issue.
- Sales-order dispatch allocation validates customer, quality, grade, and
  remaining quantity inside the posting transaction. Dispatch cancellation
  returns the allocation and reopens the order.
- Customer packing lists are generated only from posted dispatch lines; they
  cannot invent pieces or quantities outside the stock movement.
- Invoice rounding now follows the owner-selected company policy. Dated
  purchase/sales rate contracts resolve by party, quality and effective date;
  quality-specific rates take precedence. Sales brokerage is preserved on the
  invoice, posted as expense/payable in the same balanced voucher, and reversed
  exactly on cancellation.

## Do not claim these as complete

1. **CA validation:** treatment, reports, and the mill’s actual opening facts
   require written CA review. The guarded cutover records those facts; it cannot
   decide whether the facts or accounting treatment are correct.
2. **Live GSP/IRP/E-way:** no sandbox or production credential/provider round
   trip is proven by this evidence.
3. **Mill-floor proof:** actual barcode/scale hardware, network loss, label calibration, staff
   workflow, and daily reconciliation require a controlled live pilot.
4. **GSTR-1 edge cases:** the product exposes the registered-recipient
   credit/debit-note register; unregistered/export classification must be
   agreed with the CA before filing.
5. **Purchase brokerage treatment:** decide in writing whether each purchase
   brokerage class is expensed or capitalised before adding automatic posting.
6. **Release governance:** commit this candidate, create a new signed immutable
   tag, push it to an access-controlled remote before the CA review, and preserve a
   second, independent backup; a laptop-only history is not sufficient business
   continuity. This document is not evidence that either external copy exists.
7. **Public deployment:** the supplied Compose file is an internal stack. A
   public pilot still requires TLS termination, protected secrets, and a green
   `scripts/preflight.sh` result as documented in `PRODUCTION_DEPLOYMENT.md`.

The controlled-pilot routine, CA questions, and live-integration conditions are
in `CA_REVIEW_AND_MILL_PILOT.md` and `GSP_IRP_READINESS.md`.
