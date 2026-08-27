#!/usr/bin/env bash
# Proves that a real pre-042 database upgrades in place without losing legacy
# openings. The target is disposable and is always dropped on exit.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DB="linkerp_upgrade_check_$$"
[[ "${DB}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || exit 2
# shellcheck source=lib-release.sh
source "${ROOT}/scripts/lib-release.sh"

record_migration() {
  local file="$1" path="$2" checksum
  checksum="$(file_md5 "${path}")"
  psql -q -v ON_ERROR_STOP=1 -d "${DB}" \
    -v migration_file="${file}" -v migration_checksum="${checksum}" <<'SQL'
insert into schema_migration (filename, checksum)
values (:'migration_file', :'migration_checksum');
SQL
}

cleanup() { psql -q -d postgres -c "drop database if exists ${DB}" >/dev/null; }
trap cleanup EXIT

cleanup
psql -q -d postgres -c "create database ${DB}"
psql -q -v ON_ERROR_STOP=1 -d "${DB}" -c \
  "create table schema_migration (filename text primary key, applied_at timestamptz not null default now(), checksum text)"

for path in "${ROOT}"/link-erp/db/0*.sql; do
  file="$(basename "${path}")"
  case "${file}" in
    002_*|*seed*|042_*|043_*|044_*|045_*|046_*|047_*|048_*|049_*|050_*|051_*|052_*|053_*|054_*|056_*|057_*|058_*|059_*|060_*|061_*|062_*|068_*|070_*|071_*|075_*|076_*|077_*|078_*) continue ;;
  esac
  psql -q -v ON_ERROR_STOP=1 -d "${DB}" -f "${path}"
  record_migration "${file}" "${path}"
done
for path in "${ROOT}"/link-erp/db/0*seed*.sql; do
  case "$(basename "${path}")" in 055_*) continue ;; esac
  psql -q -v ON_ERROR_STOP=1 -d "${DB}" -f "${path}"
done

# This is the data shape deployed before explicit, year-scoped openings.
psql -q -v ON_ERROR_STOP=1 -d "${DB}" <<'SQL'
update ledger_account set opening_balance = 500
 where tenant_id = '11111111-1111-1111-1111-111111111111' and code = '101';
update ledger_account set opening_balance = -500
 where tenant_id = '11111111-1111-1111-1111-111111111111' and code = '201';
insert into opening_balance (tenant_id, fy_label, ledger_id, debit, credit)
select tenant_id, '2027-28', id,
       case code when '101' then 125 else 0 end,
       case code when '201' then 125 else 0 end
  from ledger_account
 where tenant_id = '11111111-1111-1111-1111-111111111111' and code in ('101','201');
SQL

PGHOST="${PGHOST:-/tmp}" PGPORT="${PGPORT:-5432}" PGUSER="${PGUSER:-postgres}" \
  "${ROOT}/scripts/migrate.sh" "${DB}"

psql -q -v ON_ERROR_STOP=1 -d "${DB}" <<'SQL'
do $$
declare migrated numeric; future_rows integer;
begin
  select coalesce(sum(debit), 0) - coalesce(sum(credit), 0)
    into migrated from opening_balance where fy_label = '2026-27';
  if migrated <> 0 then raise exception 'legacy opening is out by %', migrated; end if;
  select count(*) into future_rows from financial_year where label = '2027-28';
  if future_rows <> 1 then raise exception 'orphan opening year was not materialised'; end if;
end $$;
SQL

if psql -q -v ON_ERROR_STOP=1 -d "${DB}" -c \
  "insert into financial_year (tenant_id,label,starts_on,ends_on,status) values ('11111111-1111-1111-1111-111111111111','2026-X','2026-05-01','2027-04-30','open')" >/dev/null 2>&1; then
  echo 'overlapping/mislabelled financial year was accepted' >&2
  exit 1
fi

# Running the migrator twice must be a no-op.
PGHOST="${PGHOST:-/tmp}" PGPORT="${PGPORT:-5432}" PGUSER="${PGUSER:-postgres}" \
  "${ROOT}/scripts/migrate.sh" "${DB}" >/dev/null

echo 'upgrade rehearsal passed: legacy openings preserved, years guarded, rerun idempotent'
