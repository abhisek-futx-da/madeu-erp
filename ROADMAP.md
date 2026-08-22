# Roadmap

What is built, what is next, and what only a real mill can settle.

---

## Built

### The spine
- Piece-level barcode traceability: append-only `piece_movement`, transitions in
  data, UPDATE/DELETE blocked by rewrite rules, drift view and repair function
- Grey inward → issue to dyeing → receipt with shrinkage → cut/pack → dispatch
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

### The product
- Owner's dashboard: sales, receivables, payables, cash, stock, goods at the
  dyeing house, IRN backlog, job work past a year, monthly trend, top debtors
- Every document list searchable, date-filterable, paged and exportable to CSV
- Real keyboard shortcuts (Ctrl+S/N/P/F/E, Esc) — and no button on any screen
  without a handler behind it
- A4 tax invoice and delivery challan with amount in words

### Engineering
- 19 tracked migrations with checksums; an additive migrator for live databases
- Row-level security per tenant; the API connects as a non-owner role
- Login throttling and token revocation in the database, so both survive a
  restart and work across instances; role and membership re-read every request
- Rate limiting, security headers, strict CORS, graceful shutdown, JSON errors,
  structured request logs
- 203 server tests on a database built from scratch, 52 front-end tests, 12
  in-database invariants, CI on every push — and `scripts/ci-local.sh`, which
  runs every one of those CI steps on a laptop, because a workflow file nobody
  has executed is a guess
- A volume harness that builds a year of a working mill and fails the build if
  a query a person waits on crosses its budget
- Docker for all three tiers; verified backup and guarded restore

---

## Next

**Returns filing.** The figures are produced and reconciled; pushing them to the
portal needs a GSP subscription and a sandbox to test against.

**The process-house portal.** A dyeing house logging its own receipts and
deliveries removes the mill's largest data-entry burden and the argument about
shrinkage that follows it.

**Rework and re-processing.** A piece that comes back short-shade goes out
again; today that is a second issue with no link to the first.

**Physical stock count.** Counting the rack against the system, and an approved
variance, is the check that proves everything above. Nothing exists for it yet.

**Cutting loss.** A split must currently add up exactly; the shortage a cutter
actually leaves has to be written off as its own document, and that flow is not
built.

**Hindi and Gujarati.** The people entering the most data read those first.

**Mobile scanning.** The offline queue is built; the screens assume a desktop.

---

## Only a real mill can settle these

- Whether the shrinkage tolerances match what process houses actually agree to
- Whether piece-level barcoding survives a floor that currently works in bales
- What the brokerage rules really are, mill by mill
- Whether a CA signs off on the trial balance, the P&L and the balance sheet
- Whether the IRP and e-way bill payloads are accepted in production

The engineering questions have engineering answers. These do not.
