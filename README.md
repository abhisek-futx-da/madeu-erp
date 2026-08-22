# Link ERP — textile trading ERP

A working ERP for a cloth trader–processor: grey arrives from weavers barcoded
one piece at a time, goes out to dyeing houses on a delivery challan, comes back
as finish, is cut, packed and dispatched, and is billed under GST. Every step
posts double-entry vouchers, and every piece keeps a movement log nothing can
edit.

Modelled on the legacy Windows system a Bhiwandi mill runs today (the
screenshots in this folder), rebuilt as Postgres + a TypeScript API + a React
front end.

- **Database** — Postgres 16, row-level security per tenant, 19 tracked
  migrations
- **API** — Node 26 running TypeScript directly, Express 5, zod at every edge
- **Web** — React 19, Vite, Tailwind, strict TypeScript

---

## Running it

### With Docker (the way to run it for real)

```bash
cp .env.example .env      # then change every secret in it
docker compose up -d --build
./scripts/migrate.sh      # schema; add the demo data with db/003_seed.sql etc.
```

The app is on <http://localhost:8080>. The database is not published outside
the compose network, and the API is reached through nginx on the same origin,
so the browser never needs a CORS exemption.

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

`backup.sh` refuses to keep an archive `pg_restore --list` cannot read.
`restore.sh` will not overwrite the live database without `CONFIRM=yes`, and
after restoring it checks that the books still balance.

---

## Tests

```bash
cd server   && PGHOST=... PGPORT=... PGUSER=postgres npm test   # 203 tests
cd link-erp && npm test                                         # 52 tests

# every step the CI workflow runs, here, against a real Postgres
PGHOST=... PGPORT=... PGUSER=postgres ./scripts/ci-local.sh

# a year of a working mill, with a budget on every query a person waits for
cd link-erp/db && PGHOST=... PGPORT=... PGUSER=postgres ./load/run.sh
```

`server/test/run.sh` **builds the database from scratch on every run**, applies
the twelve in-database invariants, starts the API on its own port, and then runs
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
| `concurrency` | two users clicking at once — see below |
| `hardening` | forged tokens, throttling, oversized documents |

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

**Money is integer paise.** `numeric(14,2)` arrives in JavaScript as a double,
and adding a page of invoices as doubles produced `555407.2000000001`. Every
sum goes through `src/money.ts`, which works in paise and returns to rupees at
the boundary.

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
| E-way bill, Rule 138 (NIC EWB v1.03 payload) | GST → E-Way Bills |
| ITC-04, tables 4 and 5A | GST → ITC-04 |
| GSTR-1 B2B and HSN, GSTR-3B outward, GSTR-2B reconciliation | GST |
| Profit & loss, balance sheet, trial balance | Accounts |
| TDS 194Q / 194C deduction and summary | Accounts |

Marking a return filed (`POST /api/filings`) freezes the period: an invoice
inside it can no longer be raised or cancelled, so a filed GSTR-1 cannot change
behind the department's back. Only the owner can unlock one.

---

## Known gaps

These are real and deliberate, not oversights:

- **Nothing has been sent to a live IRP or e-way bill portal.** Both clients and
  both payloads are validated locally against the published schemas and tested
  against a fake transport; neither has made a sandbox round-trip, because both
  need a GSP subscription. `docs/einvoice-schema.md` records exactly which field
  rules were verified and which were not.
- **The returns *filing* API is not built.** GSTR-1, 3B, 2B and ITC-04 figures
  are produced, reconciled and exportable; submitting them to the portal is not.
- **TCS is deliberately absent.** 206C(1H) was withdrawn with effect from
  1 April 2025, so charging it would be wrong. See `docs/tds-rates.md`.
- **TDS is computed and posted but not filed** — no 26Q return or challan.
- **The token is in `localStorage`** and lives twelve hours with no refresh.
  Revocation, deactivation and role changes take effect immediately — they are
  re-read from the database on every request — but XSS would still yield a
  usable token.
- **A split must add up exactly.** Cutting 118 metres into 40 + 40 is refused;
  the operator has to enter the offcut as its own piece. The cutting loss a
  floor actually leaves needs a write-off document, and that is not built.
- **There is no physical stock count.** Nothing compares the rack to the ledger,
  so a discrepancy is only ever found by someone noticing.
- **No CA has audited the books and no mill has run a day's work through it.**
  That remains the only measurement that counts.

## Measured, not assumed

Built at a year's volume — 1.5 lakh pieces, 4.65 lakh movements, 209 MB — with
`link-erp/db/load/run.sh`, which fails the build if any of these regresses:

| | measured | budget |
|---|---|---|
| Barcode lookup, the query the floor runs all day | 1.4 ms | 50 ms |
| One piece's whole history | 23 ms | 100 ms |
| Invoice list, page 40 (the deep offset) | 1.3 ms | 250 ms |
| Trial balance | 9 ms | 500 ms |
| Balance sheet | 26 ms | 800 ms |
| Owner's dashboard, all fourteen figures | 153 ms | 1500 ms |
| Spine-drift check across every piece | 244 ms | 2000 ms |

Every one is index-driven; the plans are in `load/measure.sql`.
