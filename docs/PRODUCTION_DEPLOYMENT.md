# Controlled-Pilot Deployment Gate

This is the technical gate before exposing Link ERP to the pilot team. It is
not a substitute for the CA, a statutory integration provider, or a mill
acceptance. Do not market it as one.

## 1. Build a protected configuration file

Copy `.env.production.example` to a location excluded from source control and
replace every placeholder with a unique secret. Set `CORS_ORIGIN` to the one
public HTTPS address people will actually use. Do not set it to `*`, a LAN IP,
or `localhost` for a public pilot.

Run:

```bash
ENV_FILE=/protected/path/.env.production ./scripts/preflight.sh
```

The checker refuses template secrets, plain HTTP browser origins, disabled
secure cookies, invalid request-rate limits, a non-shared production limiter,
invalid JWT rotation settings, and a Compose configuration that does not parse.
It prints no secret values. Use `RATE_LIMIT_MODE=database` for every pilot.

For signing-key rotation, deploy the new `JWT_SECRET` and `JWT_KEY_ID` while
placing the former secret in `JWT_PREVIOUS_SECRETS`. Remove the former secret
after the longest issued session has expired; do not retain an indefinite key
ring.

## 2. Terminate TLS before the web container

The supplied Compose stack is intentionally an internal HTTP stack. Put a
managed load balancer or a maintained TLS reverse proxy in front of it. The
public DNS name must serve a valid certificate and forward only to the web
container. Do not publish Postgres or the API directly.

Then set `FORCE_HTTPS=true`. The API will issue secure, HttpOnly, SameSite
cookies and its HTTP responses carry HSTS. The web shell also sends CSP,
anti-framing, referrer, and permissions headers.

## 3. Deploy and create the real mill safely

1. Build the exact reviewed source revision.
2. Apply migrations with `./scripts/migrate.sh`; never use `rebuild.sh` on a
   database containing business data.
   Run `./scripts/check-db-hygiene.sh` against the migrated database and retain
   its migration-count and foreign-key-index result with the release evidence.
3. Copy `.bootstrap-tenant.example` to a protected local file called
   `.bootstrap-tenant.env`. Fill it with the legal entity's registered facts
   and the first named owner. The GSTIN, PAN, state code, and 1 April financial
   year start are checked before any row is created. It must not contain a
   demo identity or a password reused anywhere else.
4. Run the one-time tool. It has no HTTP endpoint and uses the protected
   database credential only inside the Compose network:

   ```bash
   docker compose --env-file .env.production --env-file .bootstrap-tenant.env \
     --profile tools run --rm bootstrap
   ```

   Its JSON result is the durable evidence of the created tenant ID, owner,
   financial year, and system-ledger count. A duplicate GSTIN or owner email
   fails as one transaction and leaves no partial company behind. Delete the
   protected bootstrap file after the owner has signed in and changed the
   temporary password.
5. Do **not** use any `*_seed.sql` file for a real company. The bootstrap
   intentionally leaves bank accounts, parties, HSN/SAC and GST rates,
   qualities/designs, racks, rate contracts, opening balances, TDS/TCS rules,
   brokerage, shrinkage tolerance, and commercial approval limits empty.
   Add and reconcile those using the signed mill/CA setup pack before posting
   a live document. It does create the neutral chart, stock and tax posting
   ledgers, document series, standard units, and a mandatory independent
   approval for every physical stock count.
6. Create a backup with `./scripts/backup.sh` and copy it to independent
   storage under the owner's control. The scripts select a matching official
   PostgreSQL client image if the host's archive tools are older than the
   database server.
7. Prove the copy restores into a different database using
   `./scripts/verify-backup-restore.sh`.
8. Record the release revision, migration count, bootstrap result, backup
   timestamp, restore result, full `scripts/ci-local.sh` result, and the people
   permitted to operate the system.

## 4. Establish staff access before documents

The owner creates named accounts in **Masters → People & Access**. Give every
worker their own address and temporary password privately. They change it in
**Home → My Password**. Remove a leaver by disabling their membership; this
invalidates their existing sessions. The database refuses to remove the last
active owner, and the Access Audit records every create, change, disable, and
reset.

Use no shared account, no demo account, and no password in a spreadsheet,
WhatsApp chat, ticket, screenshot, or source file.

## 5. Prove local and messaging integrations

On every godown PC that prints or weighs, install the service described in
`../hardware-bridge/README.md`. Use a unique pairing token, the exact ERP HTTPS
origin, and loopback-only bridge URLs. Print and scan a calibration set on the
actual label stock, then compare scale readings with certified weights. Record
printer model, DPI, language, label dimensions, scale protocol, baud rate, and
the accepted samples. Passing the bridge unit tests is not that acceptance.

Keep WhatsApp variables blank until the invoice-document and payment-reminder
templates have provider approval and each recipient class has a lawful consent
process. When enabled, send only from the ERP outbox: prove customer and broker
invoice PDFs, outstanding statements, failed-send backoff, cancellation, and
duplicate suppression. A provider acceptance ID proves delivery processing;
it does not prove the recipient read or accepted the books.

Import the Tally XML into a disposable copy of the mill's Tally company. Match
ledger masters, voucher counts, debit/credit totals, and closing balances. Do
not import into the live Tally company until the accountant and CA sign that
reconciliation.

## 6. Start the pilot, not a broad rollout

Follow `CA_REVIEW_AND_MILL_PILOT.md` for the daily reconciliation and exit
criteria. Keep the existing accounting system in parallel until the CA and
owner accept a closed period. Follow `GSP_IRP_READINESS.md` separately before
enabling any statutory submission.
