#!/usr/bin/env bash
# Rebuilds the database from scratch: schema, seed, invariants.
# Usage: PGHOST=... PGPORT=... PGUSER=... ./rebuild.sh [dbname]
set -euo pipefail

DB="${1:-linkerp}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "${HERE}/../.." && pwd)"
# shellcheck source=../../scripts/lib-release.sh
source "${ROOT}/scripts/lib-release.sh"

record_migration() {
  local file="$1" path="$2" checksum
  checksum="$(file_md5 "${path}")"
  psql -q -v ON_ERROR_STOP=1 -d "${DB}" \
    -v migration_file="${file}" -v migration_checksum="${checksum}" <<'SQL'
insert into schema_migration (filename, checksum)
values (:'migration_file', :'migration_checksum')
on conflict (filename) do nothing;
SQL
}

psql -q -c "drop database if exists ${DB};" -c "create database ${DB};" postgres
psql -q -v ON_ERROR_STOP=1 -d "${DB}" -c "
  create table if not exists schema_migration (
    filename text primary key,
    applied_at timestamptz not null default now(),
    checksum text
  );"
for migration in 001_schema 004_gst 006_tenant_address 007_config 008_reports 010_tds_close 012_retained_earnings 014_money 015_hygiene 017_reversals 018_integrity 019_statutory 020_reporting 021_indexes 022_approvals 023_approval_views 025_posted_only 026_regroup 027_lineage_doc_id 028_stock_count 030_count_in_queue 031_cutting_loss 032_returns 033_customer_returns 034_returns_approval 036_write_off 037_exception_integrity 038_gst_note_lifecycle 039_return_maker_checker 040_approval_cancellations 041_user_access 042_accounting_openings 043_financial_year_guard 044_bank_reconciliation 045_mfa 046_reprocess 047_receipt_reentry 048_fk_indexes 049_brokerage_posting 050_distributed_rate_limit 051_dual_uom 052_kapat_brokerage 053_process_house_bills 054_notification_outbox; do
  psql -q -v ON_ERROR_STOP=1 -d "${DB}" -f "${HERE}/${migration}.sql"
  record_migration "${migration}.sql" "${HERE}/${migration}.sql"
  echo "${migration} applied"
done

for seed in 003_seed 005_seed_gst 009_seed_config 011_seed_tds 013_seed_retained 016_seed_money 024_seed_approvals 029_seed_stock_count 055_seed_mill_readiness; do
  psql -q -v ON_ERROR_STOP=1 -d "${DB}" -f "${HERE}/${seed}.sql"
  echo "${seed} applied"
done

# The `|| true` that used to end this line meant a failing invariant could not
# fail a build. All eighteen must pass; anything else stops the script.
INVARIANTS="$(psql -q -d "${DB}" -f "${HERE}/002_test_invariants.sql" 2>&1 | grep -E 'PASS|FAIL|ERROR' || true)"
echo "${INVARIANTS}"

PASSED="$(printf '%s\n' "${INVARIANTS}" | grep -c 'PASS' || true)"
FAILED="$(printf '%s\n' "${INVARIANTS}" | grep -cE 'FAIL|ERROR' || true)"
echo "invariants: ${PASSED} passed, ${FAILED} failed"

if [ "${FAILED}" -ne 0 ] || [ "${PASSED}" -ne 18 ]; then
  echo "expected 18 passing invariants and no failures" >&2
  exit 1
fi
