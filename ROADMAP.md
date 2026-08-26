# Roadmap

What is built, what is next, and what only a real mill can settle.

---

## Built

### The spine
- Piece-level barcode traceability: append-only `piece_movement`, transitions in
  data, UPDATE/DELETE blocked by rewrite rules, drift view and repair function
- Grey inward → issue to dyeing → receipt with shrinkage → cut/pack → dispatch
- Audited piece-wise opening stock by business location and rack; exact carried
  grey/job-work/other value, and a hard lock after live accounting starts
- Barcode-scanned cross-godown transfers that preserve metres, kilograms,
  stage, and value, with location history and dependency-guarded reversal
- Partial rolls: a thaan splits into pieces and short ends merge back, with
  metres and rupees conserved to the paise, lineage recorded append-only, and
  the whole regroup cancellable while its children have not moved on. Goods
  lying at a process house cannot be cut — they are not in our custody
- Shrinkage policy enforced per process house and quality, not merely displayed
- Cancellation of eight document types: reversed, never deleted, with
  downstream-dependency guards and a per-piece walk-back
- Code 128 labels generated locally as SVG — no CDN, and it now refuses to
  encode a character the symbology cannot carry rather than silently dropping it
- Offline scan queue in IndexedDB that flushes on reconnect

### Money
- Double-entry throughout, with a deferred constraint trigger that refuses an
  unbalanced voucher
- Inventory valuation: grey capitalised at inward, jobwork added at receipt,
  cost released to COGS on sale
- Receipts and payments with bill-by-bill allocation, on-account balances,
  oldest-first suggestion, cash book, bank accounts
- Credit limits that stop a dispatch before the truck loads
- Profit & loss and balance sheet, both period-selectable and exportable
- Year-end close with retained earnings, and a closed year that refuses postings
- All rupee arithmetic in integer paise through one shared module

### GST
- Place of supply → intra-state (CGST+SGST) vs inter-state (IGST), integer
  paise, rupee rounding to a round-off ledger
- E-invoice INV-1 v1.1 payload, validated field by field against the NIC schema
- E-way bill NIC EWB v1.03 payload, for invoices and for job-work challans,
  with Rule 138(10) validity and the Rule 138(1) threshold
- Rule 55 delivery challan, printable, with every field the rule requires
- ITC-04 tables 4 and 5A, plus a s.143(1) twelve-month watch
- GSTR-1 B2B and HSN, GSTR-3B outward, GSTR-2B reconciliation
- Credit and debit notes; reverse charge on unregistered purchases
- TDS 194Q and 194C with both statutory bases
- Filing lock: a filed period cannot be changed behind the return

### Control
- Maker–checker on invoices, purchase bills and payments above a per-tenant
  limit the owner sets: the document is raised but its postings are held, and
  a second person with the required role releases them
- The maker can never be the checker, enforced in the transaction
- A rejected document's postings are dropped, never posted
- An approval queue showing what is held, by whom, and for how long
- Named business locations, active-location switching, role-matched permission
  profiles, and owner-only commercial readiness checks before pilot data
- PDF/JPEG/PNG evidence retained against commercial documents with SHA-256
  integrity, duplicate prevention, and append-only add/remove history

### The product
- Owner's dashboard: sales, receivables, payables, cash, stock, goods at the
  dyeing house, IRN backlog, job work past a year, monthly trend, top debtors
- Every document list searchable, date-filterable, paged and exportable to CSV
- Personal saved report filters, configurable columns, and exports that match
  the current filtered rows and visible-column layout
- Shared typed custom fields for masters and transactions; a governed report
  builder with private/company definitions; and an auditable integration event
  feed with one-time hashed credentials, acknowledgements, pause and rotation
- Controlled CSV cutover for opening books, bill-wise outstandings, and
  barcode stock, with templates, reference validation, review/confirmation,
  transaction-wide rollback, and live-posting locks
- Real keyboard shortcuts (Ctrl+S/N/P/F/E, Esc) — and no button on any screen
  without a handler behind it
- A4 tax invoice and delivery challan with amount in words

### Parallel editions
- **Weaving:** nine workflows from yarn receipt, warping and sizing through loom
  planning/production, fabric inspection, settlement, and maintenance
- **Dyeing:** nine workflows from lab dip, recipe and chemical receipt through
  batch processing, release, reprocessing, scheduling, and batch costing
- **Exports:** nine workflows from export order and LC through shipment,
  document pack, compliance, incentives, forex realisation, and bank closure
- **Logistics:** eight workflows for routing, LR/consignment, trips, fuel/toll,
  delivery, maintenance, freight billing, and transporter settlement
- **Garments:** eleven workflows from sample/BOM/order through marker, cutting,
  bundles, production, subcontract, quality, finished goods, and final costing
- All 46 workflows use strict typed validation, independent FY document series,
  guarded draft/active/hold/complete/cancel lifecycles, append-only history,
  tenant isolation, permission profiles, attachments, custom fields, CSV
  registers, shared reporting, tenant-wide search, and integration events.
- Edition resources feed an append-only average-cost stock ledger; material and
  cost lines calculate document/job cost, parent links retain process lineage,
  and owners can require independent maker-checker approval per workflow.
- Each edition can be paused independently by an owner without removing its
  retained records or disabling the common accounting and inventory system.

### Engineering
- 51 tracked migrations with checksums; an additive migrator for live databases
- Row-level security per tenant; the API connects as a non-owner role
- Login throttling and token revocation in the database, so both survive a
  restart and work across instances; role and membership re-read every request
- Rate limiting, security headers, strict CORS, graceful shutdown, JSON errors,
  structured request logs
- 345 server tests on a database built from scratch, 104 front-end tests, 20
  in-database invariants, CI on every push — and `scripts/ci-local.sh`, which
  runs every one of those CI steps on a laptop, because a workflow file nobody
  has executed is a guess
- A volume harness that builds a year of a working mill and fails the build if
  a query a person waits on crosses its budget
- Docker for all three tiers; verified backup and guarded restore

---

## Frozen, on purpose

**The multi-edition platform layer** — `editions.ts`, `platform.ts`,
`commercial-foundation.ts`, `docs/SHARED_PLATFORM.md`,
`docs/PARALLEL_EDITIONS.md` and migrations 057–062 — is built, tested and
committed, and is taking no further work until one mill has run one month.

It is not wrong code. It is the wrong code to be improving now: a platform that
serves several verticals before a single fabric converter has counted a single
rack optimises for a customer nobody has met, at the cost of the one who is
nearly here. The narrow promise is still "every thaan traceable, every
process-house balance reconciled, every rupee visible to the owner" — and none
of the remaining work on that promise lives in these files.

Unfreeze when a paying pilot asks for a second vertical, and not before.

---

## Next

**Returns filing.** The figures are produced and reconciled; pushing them to the
portal needs a GSP subscription and a sandbox to test against.

**The process-house portal.** A dyeing house logging its own receipts and
deliveries removes the mill's largest data-entry burden and the argument about
shrinkage that follows it.

**External statutory acceptance.** Complete a GSP/IRP and e-way sandbox round
trip, then implement portal filing only against the selected provider contract.

**Controlled mill acceptance.** Reconcile one real operating cycle in parallel
with the current books, actual printers/scales, Tally import, and CA sign-off.

**Hindi and Gujarati.** The people entering the most data read those first.

**Dedicated handheld scanning.** The responsive/offline screens work today; a
camera-first or rugged-device flow would reduce taps further.

---

## Only a real mill can settle these

- Whether the shrinkage tolerances match what process houses actually agree to
- Whether piece-level barcoding survives a floor that currently works in bales
- What the brokerage rules really are, mill by mill
- Whether a CA signs off on the trial balance, the P&L and the balance sheet
- Whether the IRP and e-way bill payloads are accepted in production

The engineering questions have engineering answers. These do not.
