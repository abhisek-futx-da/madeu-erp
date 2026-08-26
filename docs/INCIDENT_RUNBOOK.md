# Incident runbook

For the person holding the phone at two in the morning, who may not be the
person who wrote this.

Every procedure below assumes only a shell on the host and the repository
checked out at `/srv/link-erp`. Nothing here needs a developer.

**The first rule.** If you are not certain what is wrong, stop the operators
before you debug. A mill posting documents against a half-broken system creates
work that takes days to unpick; ten minutes of nobody working costs almost
nothing. Tell them to stop scanning and stop billing, then read on.

---

## 0. Three commands that answer most questions

```bash
curl -fsS https://erp.example.com/health                                    # is it alive
curl -fsS -H "authorization: Bearer $METRICS_TOKEN" https://erp.example.com/metrics | head -40
docker compose -f /srv/link-erp/docker-compose.yml ps                       # what is running
```

`/health` answers `{"ok":true,...}` when the API is up **and** the database
answers. `/metrics` adds the backlogs. Everything below starts from one of them.

---

## 1. The health check is failing

**Symptom:** `monitor-health.sh` alerted, or `/health` does not return `ok:true`.

1. **Is the API process alive?**
   ```bash
   docker compose -f /srv/link-erp/docker-compose.yml ps api
   docker compose -f /srv/link-erp/docker-compose.yml logs --tail=100 api
   ```
   A crash loop is usually a bad environment variable. The API refuses to start
   — deliberately — when `JWT_SECRET` is missing, when `RATE_LIMIT_PER_MINUTE`
   is not a positive integer, or when `RATE_LIMIT_MODE=database` and the
   `api_rate_limit` table is unreachable. The log line names which.

2. **Is the database alive?**
   ```bash
   docker compose -f /srv/link-erp/docker-compose.yml exec db pg_isready -U postgres
   ```
   If not, section 2.

3. **Is it up but refusing everything?** Check for `429` in the log. If a single
   client is hammering it, block that IP at the proxy; do not raise
   `RATE_LIMIT_PER_MINUTE` during an incident.

4. **Restart, once.**
   ```bash
   docker compose -f /srv/link-erp/docker-compose.yml restart api
   ```
   In-flight transactions are allowed to finish; the API drains for up to
   fifteen seconds. If a restart fixes it and you do not know why, that is not
   resolved — capture the logs before they roll.

---

## 2. The database is down or will not accept connections

1. `docker compose ... logs --tail=200 db` — look for "out of disk", "PANIC", or
   a failed start.
2. **Out of disk** is the common one. `df -h`. Backups live in `./backups` by
   default; that is also the first thing to move, not delete.
3. Do **not** restore a backup because the database will not start. Restoring
   loses everything since the last dump. Get the existing data directory
   readable first; a restore is section 3 and is a last resort.

---

## 3. Restoring from a backup

**Only when the current data is gone or provably corrupt.** A restore throws
away every document created since the dump was taken.

```bash
ls -lt /srv/link-erp/backups | head           # newest first
# Always into a scratch database first, and look at it:
cd /srv/link-erp && ./scripts/restore.sh backups/linkerp-YYYYMMDD-HHMMSS.dump.gpg linkerp_check
```

`restore.sh` decrypts a `.dump.gpg` on its own — set `BACKUP_PASSPHRASE`, or
have the private key on the box. After restoring it checks the migration
history, that tenants exist, that every posted voucher balances, and that the
piece cache matches its movement log. **Read that output.** If it does not say
those things passed, the archive is not trustworthy; try the previous one.

Only then, and only with the owner's spoken agreement:

```bash
CONFIRM=yes ./scripts/restore.sh backups/....dump.gpg linkerp
```

Afterwards, tell the mill the exact cut-off time. Everything they did after it
must be re-entered, and they need to know that before they start working again.

---

## 4. Backups themselves

**`backup.sh` warns loudly when an archive is unencrypted or never leaves the
machine.** If you see either warning in the nightly log, that is a defect to fix
in daylight, not an emergency.

```bash
cd /srv/link-erp && ./scripts/verify-backup-restore.sh
```

Run this monthly. It takes a fresh backup, restores it into a throwaway
database, and — when `gpg` is present — also proves the encrypted, mirrored copy
decrypts and restores. A backup nobody has restored is a backup nobody has.

---

## 5. A backlog alert fired

`monitor-alerts.sh` alerts on work waiting for a **person**, not on software
failure. Nothing here is an outage; all of it costs money quietly.

| Alert | What it means | What to do |
|---|---|---|
| approvals waiting | Invoices, bills, payments or stock counts held for a second signature | Tell the owner/accountant. Nothing posts until they act. |
| declarations nobody has answered | A process house told the mill something and no one replied | Inventory → Process Houses. Every unanswered row is a future argument. |
| challans not acknowledged | Goods were sent out and the dyeing house has not confirmed receipt | Phone them. Either they have not logged in, or the goods are not there. |
| **thaans out beyond twelve months** | **s.143(1): job-work goods not returned within a year become a deemed supply** | Escalate to the CA the same week. This one has a tax consequence. |
| invoices with no IRN | E-invoice backlog | See section 6. |
| connections waiting | The pool is saturated | Check for a runaway report or a stuck transaction; raise `PG_POOL_MAX` only after looking. |

---

## 6. Statutory submission is failing

**Read this before telling anyone a return was filed.** As of this runbook, no
payload from this system has been accepted by a government portal — there is no
live provider credential and no sandbox round trip. `docs/GSP_IRP_READINESS.md`
records exactly what is and is not proven.

So an "e-invoice backlog" alert today means invoices are queued locally, not
that a submission failed. When a provider is connected, failures appear in the
document's own error history and the document stays visibly pending or
rejected — never silently marked accepted.

---

## 7. Someone's access must be cut off now

```bash
# A staff member: deactivate in the app — People & Access → deactivate.
# Every existing session dies on the next request; role and status are re-read
# on every single request rather than trusted to the token.

# A process house: Inventory → Process Houses → Disable.
# Same immediacy: the binding is checked on every portal request.

# Everyone, everywhere, immediately: rotate the signing key.
#   set a new JWT_SECRET, move the old value into JWT_PREVIOUS_SECRETS to let
#   current sessions expire gracefully, or omit it to sign everyone out at once.
docker compose -f /srv/link-erp/docker-compose.yml up -d api
```

---

## 8. Stock and the books disagree

If a report looks wrong, **do not edit the database.** There is no supported
path that does, and every correction has a document:

- Physical stock wrong → Inventory → Physical Stock Count. A variance becomes a
  named, valued, approved event.
- A document was wrong → cancel it. Cancellation reverses the vouchers and walks
  the pieces back; nothing is deleted.
- The piece cache disagrees with its movement log → the `piece-drift` report
  lists it, and that is a defect worth a bug report. `repair_piece_fold()`
  exists but re-folds the log onto the cache; run it only after someone has
  looked at why they diverged.

---

## 9. What to write down

Whatever happened, record it before you sleep: what alerted, what you saw, what
you did, and what the mill has to re-enter. `docs/RELEASE_EVIDENCE.md` is where
release facts live; an incident belongs next to it. The next person on the phone
at two in the morning may be you, with no memory of tonight.
