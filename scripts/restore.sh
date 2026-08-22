#!/usr/bin/env bash
#
# Restores a backup. Deliberately awkward: it refuses to overwrite a live
# database unless told twice, because the moment you need this is the moment
# you are least careful.
#
#   ./scripts/restore.sh backups/linkerp-20260821-221500.dump linkerp_restore_check
#   CONFIRM=yes ./scripts/restore.sh backups/....dump linkerp
#
# Restore into a scratch database and look at it before you overwrite anything.
set -euo pipefail

FILE="${1:?usage: restore.sh <dump-file> [target-db]}"
TARGET="${2:-linkerp_restore_check}"
DB_LIVE="${POSTGRES_DB:-linkerp}"

[ -f "${FILE}" ] || { echo "no such file: ${FILE}" >&2; exit 1; }
pg_restore --list "${FILE}" > /dev/null || { echo "not a readable archive" >&2; exit 1; }

if [ "${TARGET}" = "${DB_LIVE}" ] && [ "${CONFIRM:-}" != "yes" ]; then
  cat >&2 <<MSG
Refusing to overwrite the live database "${DB_LIVE}".

Restore into a scratch database first and check it:
  ./scripts/restore.sh "${FILE}" linkerp_restore_check

If you really mean to replace the live one:
  CONFIRM=yes ./scripts/restore.sh "${FILE}" ${DB_LIVE}
MSG
  exit 1
fi

echo "==> recreating ${TARGET}"
psql -q -U postgres -d postgres \
  -c "drop database if exists ${TARGET};" \
  -c "create database ${TARGET};"

echo "==> restoring"
pg_restore -U postgres -d "${TARGET}" --no-owner --role=postgres "${FILE}"

echo "==> checking the restore is usable"
psql -q -U postgres -d "${TARGET}" -v ON_ERROR_STOP=1 <<'SQL'
select 'migrations recorded: ' || count(*) from schema_migration;
select 'tenants: ' || count(*) from tenant;
set app.tenant_id = '11111111-1111-1111-1111-111111111111';
-- The books must still balance, or the archive is not worth keeping.
select case when abs(coalesce(sum(debit - credit), 0)) < 0.01
            then 'books balance'
            else 'BOOKS OUT BY ' || sum(debit - credit)::text end
  from voucher_line;
SQL

echo "restored into ${TARGET}"
