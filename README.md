# Link ERP — textile trading ERP

A working ERP for a cloth trader–processor: grey arrives from weavers barcoded
one piece at a time, goes out to dyeing houses on a delivery challan, comes back
as finish, is cut, packed and dispatched, and is billed under GST. Every step
posts double-entry vouchers, and every piece keeps a movement log nothing can
edit.

Modelled on the legacy Windows system a Bhiwandi mill runs today. Local design
references and one-off repair artifacts are kept under `_local_archive/` and
are deliberately excluded from the release source.

- **Database** — Postgres 16, row-level security per tenant, 45 tracked
  migrations
- **API** — Node 26 running TypeScript directly, Express 5, zod at every edge
- **Web** — React 19, Vite, Tailwind, strict TypeScript

---

## Running it

### With Docker (local evaluation or an internal pilot)

```bash
cp .env.example .env      # then change every secret in it
docker compose up -d db
./scripts/migrate.sh      # schema only
docker compose up -d --build
```

The app is on <http://localhost:8080>. The database is not published outside
the compose network, and the API is reached through nginx on the same origin,
so the browser never needs a CORS exemption.

This command is intentionally **not** a public-internet deployment. Before a
controlled pilot is exposed outside the mill network, put HTTPS in front of the
web container, use the protected production environment file, and run:

```bash
ENV_FILE=.env.production ./scripts/preflight.sh
```

See `docs/PRODUCTION_DEPLOYMENT.md`. A green preflight checks configuration;
it does not replace CA review, an IRP sandbox test, or a mill pilot.

For a real mill, never run the demo seed scripts. After migrations, use the
profile-gated empty-company bootstrap in `docs/PRODUCTION_DEPLOYMENT.md`.
It creates the named company, owner, system accounts, open financial year,
document series, and the stock-count second signature; it creates no dummy
party, stock, bank, HSN/SAC, rate, or accounting transaction.

### Locally, for development

```bash
# 1. a database
cd link-erp/db && PGHOST=... PGPORT=... PGUSER=postgres ./rebuild.sh linkerp

# 2. the api
cd server && npm ci && npm run dev          # :4000

# 3. the web app
cd link-erp && npm ci && npm run dev        # :3000
```

Sign in as `owner@neelkamal.test` / `changeme`. Other seeded roles: `store`,
`accounts`, `sales`, `viewer` — same password, different write permissions.

To click around the throwaway database the test suite builds, without touching
your own: `npm --prefix server run dev:test-db` (:4010) and
`npm --prefix link-erp run dev:test-db` (:3010).

### Backups

```bash
./scripts/backup.sh                     # verified pg_dump into ./backups
./scripts/restore.sh backups/x.dump     # into a scratch database, checked
```

`backup.sh` refuses to keep an archive `pg_restore --list` cannot read. If the
host tools are older than the database, the scripts automatically use the
matching official PostgreSQL client image rather than creating an unreadable
or incompatible archive.
`restore.sh` will not overwrite the live database without `CONFIRM=yes`, and
after restoring it checks the migration history, tenant presence, every posted
voucher's balance, and the piece cache against its append-only movement log.

---

## Tests

```bash
cd server   && PGHOST=... PGPORT=... PGUSER=postgres npm test   # 314 tests
cd link-erp && npm test                                         # 91 tests

# every step the CI workflow runs, here, against a real Postgres
PGHOST=... PGPORT=... PGUSER=postgres ./scripts/ci-local.sh

# a year of a working mill, with a budget on every query a person waits for
cd link-erp/db && PGHOST=... PGPORT=... PGUSER=postgres ./load/run.sh
```

`server/test/run.sh` **builds the database from scratch on every run**, applies
the twenty in-database invariants, starts the API on its own port, and then runs
the suite. This matters: the suite used to run against one shared, accumulating
database, and creating four documents by hand was enough to fail twenty of a
hundred and thirty-one tests. A run is now repeatable or it is not a run.

What the suites cover:

| Suite | What it holds down |
|---|---|
| `api` | the full lifecycle, RBAC, tenant isolation, revenue recognised once |
| `gst` / `invoice` | intra vs inter-state, rounding, GSTR-1/3B, IRP payload |
| `irp` | e-invoice client, retries, error mapping — against a fake transport |
| `accounts` | purchases, RCM, credit and debit notes, trial balance |
| `close` | year end, retained earnings, a closed year refusing postings |
| `money` | valuation, receipts, allocation, credit limits, cancellation |
| `money-unit` | rupee arithmetic in integer paise, amount in words |
| `statutory` | delivery challan, e-way bill payload, ITC-04, the filing lock |
| `approvals` | maker–checker: held postings, role, maker ≠ checker |
| `regroup` | cutting a thaan and joining short ends: metres and rupees conserved |
| `reprocess` | rejected finish, re-issue, corrected receipt, shrinkage and incremental job-work |
| `purchase-order` | supplier PO printing, receipt balance and cancellation dependencies |
| `bank-reconciliation` | statement matching, unreconciled items and close controls |
| `stockcount` | offline scan batches, six variance classes, second-person posting |
| `onboarding-search` | owner-controlled master imports, atomic apply, tenant-wide linked search |
| `mill-readiness` | kg/metre stock, kapat, realized brokerage, process-bill matching, Tally XML, PDF/WhatsApp outbox |
| `concurrency` | two users clicking at once — see below |
| `hardening` | forged/rotated tokens, database-backed throttling, oversized documents |
| `db-parser` | unsafe numeric/int8 values are refused before JavaScript can round them |

`concurrency.test.ts` exists because the suite once had tests *named* for
guarantees it did not have. "A dispatch cannot be invoiced twice" fired its two
requests one after the other; the defect was in the overlap. Two tax invoices
for one dispatch, and a receivable driven negative by paying a bill twice, were
both demonstrated against a running instance before being fixed.

---

## What holds the design together

**A piece is the unit of truth.** `piece` carries a cached status and quantity;
`piece_movement` is the append-only log that produced them. Rewrite rules block
UPDATE and DELETE on the log, a trigger checks every transition against
`piece_status_transition`, and `v_piece_drift` makes any disagreement between
the cache and the log visible.

**A barcode is never reused, and never quietly disappears.** Cutting a thaan
retires the parent to `consumed` and creates children; `piece_lineage` records
which became which and how much cost went with it, append-only. Nothing is
edited: `v_regroup_imbalance` lists any regroup whose metres do not reconcile,
the same way `v_piece_drift` lists a cache that has drifted from its log.

**Decisions live in data, not in branches.** Legal status transitions, shrinkage
policies, brokerage rules, posting roles and tenant settings are all rows. A new
rule is an INSERT.

**One ledger per posting role.** `posting_role` is an enum with a unique index,
so nothing ever resolves an account by matching on its name.

**Money is integer paise.** PostgreSQL numeric and int8 values are accepted by
the API only when their scaled integer is inside JavaScript's safe range; an
unsafe value is rejected instead of silently rounded. Every sum goes through
`src/money.ts`, which works in paise and returns to rupees at the boundary.

**A clerk may compare without losing a draft.** Up to eight ERP screens remain
mounted in an accessible workspace. Read-only data is briefly cached and
revalidated; every successful financial write invalidates the cache, and no
accounting write is shown optimistically.

**Tenancy is the database's job.** Every tenant-scoped table has RLS keyed on
`current_setting('app.tenant_id')`, and the API connects as a non-owner role
that cannot bypass it or alter the schema.

**Constraints, not conventions.** One live invoice per dispatch, allocations
that cannot exceed the invoice, vouchers that cannot post unbalanced — all
enforced by unique indexes and deferred constraint triggers, because an
application-level check is a race waiting for two users.

**A document over the limit is not posted until a second person agrees.** Its
voucher lines are held in `deferred_voucher` and replayed on approval, so the
entries the approver agreed to are the entries that land. The maker can never
be the checker, and that is checked in the database transaction rather than
trusted to the screen.

---

## Statutory documents

| Document | Where |
|---|---|
| Tax invoice + IRP (INV-1 v1.1) payload | Accounts → Tax Invoices |
| Delivery challan, Rule 55 | Inventory → Delivery Challans |
| Customer packing list, derived from posted dispatch pieces | Inventory → Packing Lists |
| Supplier purchase order and remaining receipt quantity | Inventory → Purchase Orders |
| E-way bill, Rule 138 (NIC EWB v1.03 payload) | GST → E-Way Bills |
| ITC-04, tables 4 and 5A | GST → ITC-04 |
| GSTR-1 B2B and HSN, GSTR-3B outward, GSTR-2B reconciliation | GST |
| Profit & loss, balance sheet, trial balance | Accounts |
| TDS 194Q / 194C deduction and summary | Accounts |
| Tally Prime ledger/voucher XML | Mill Integration |
| Invoice + LR/packing PDF and outstanding-statement PDF | Tax Invoices / Mill Integration |

Marking a return filed (`POST /api/filings`) freezes the period: an invoice
inside it can no longer be raised or cancelled, so a filed GSTR-1 cannot change
behind the department's back. Only the owner can unlock one.

The owner onboarding workbench imports seven master types from
Excel-compatible CSV: ledgers, qualities, HSN/SAC codes, grades, units, widths,
and racks. Every file is previewed and cross-checked before an atomic apply;
rejected rows and immutable batch history remain downloadable. This is master
data onboarding, not an opening-balance or opening-stock conversion. Global
operational search links matching pieces, parties, orders, dispatches,
invoices, payments, GST notes, and e-way bills back to their exact screens.

---

## Known gaps

These are real and deliberate, not oversights:

- **No live statutory round trip is proven.** Both clients and payloads are
  validated locally against published schemas and a fake transport, but neither
  has made a GSP/IRP sandbox round trip. `docs/einvoice-schema.md` records the
  verified field rules and remaining external checks.
- **The returns *filing* API is not built.** GSTR-1, 3B, 2B and ITC-04 figures
  are produced, reconciled and exportable; submitting them to the portal is not.
- **TCS is deliberately absent.** 206C(1H) was withdrawn with effect from
  1 April 2025, so charging it would be wrong. See `docs/tds-rates.md`.
- **TDS is computed and posted but not filed** — no 26Q return or challan.
- **Purchase brokerage is not auto-posted.** Sales brokerage resolves the
  configured broker/rule and accrues in the invoice voucher; purchase
  brokerage may need capitalisation or expensing, so its accounting treatment
  remains a CA decision rather than a guessed posting.
- **No CA has audited the books and no mill has run a day's work through it.**
  That remains the only measurement that counts.
- **No physical printer/scale combination is proven.** The loopback bridge,
  raw ZPL/TSPL validation, network/CUPS printer paths, and serial/TCP scale
  capture are tested in code; label calibration, scale protocol, dust, power,
  and operator speed must pass on the pilot's actual hardware.
- **No live WhatsApp template/provider round trip is proven.** The outbox is
  idempotent, retries with backoff, attaches invoice/packing or outstanding
  PDFs, supports buyer/broker copies and payment reminders, and refuses to
  pretend delivery when credentials are absent. Meta template approval,
  consent, phone quality, and live delivery receipts remain external gates.
- **Tally import is not yet accepted evidence.** The export contains ledger
  masters and balanced posted vouchers, but it must be imported into a copy of
  the mill's real Tally company and reconciled by the accountant/CA.
- **Process-house reconciliation is internal, not a vendor portal.** Mixed and
  partial receipts can be matched to a consolidated supplier bill without
  FIFO guessing; a process house cannot yet log in and confirm its own balance.
- **Cross-company staff invitations are deliberately absent.** An owner may
  create, disable, re-enable, role-change, and reset a worker for this company;
  an existing user from another company cannot be attached until an auditable
  invitation flow is designed and tested.

## Measured, not assumed

Built at a year's volume — 1.5 lakh pieces, 4.65 lakh movements, 214 MB — with
`link-erp/db/load/run.sh`, which fails the build if any of these regresses:

| | measured | budget |
|---|---|---|
| Barcode lookup, the query the floor runs all day | 3.9 ms | 50 ms |
| One piece's whole history | 40.5 ms | 100 ms |
| Invoice list, page 40 (the deep offset) | 6.0 ms | 250 ms |
| Pieces by status after the RLS-specific index fix | 23.0 ms | 300 ms |
| Trial balance | 36.9 ms | 500 ms |
| Balance sheet | 75.8 ms | 800 ms |
| Owner's dashboard, all fourteen figures | 273.8 ms | 1500 ms |
| Spine-drift check across every piece | 968.5 ms | 2000 ms |

All defined waits are under budget; the plans are in `load/measure.sql`.
