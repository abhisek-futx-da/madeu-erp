#!/usr/bin/env bash
#
# Applies any migration the target database has not recorded yet, and nothing
# else. Unlike db/rebuild.sh this never drops anything — it is the one to run
# against a database that has real data in it.
#
#   ./scripts/migrate.sh                    # against the compose database
#   PGHOST=... PGPORT=... ./scripts/migrate.sh linkerp
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
DB="${1:-${POSTGRES_DB:-linkerp}}"
MIGRATIONS="${HERE}/link-erp/db"
# shellcheck source=lib-release.sh
source "${HERE}/scripts/lib-release.sh"

# Inside compose the database is not published, so go through the container.
if [ -z "${PGHOST:-}" ] && docker compose -f "${HERE}/docker-compose.yml" ps db --status running >/dev/null 2>&1; then
  psql() { docker compose -f "${HERE}/docker-compose.yml" exec -T db psql -U postgres "$@"; }
  send() { docker compose -f "${HERE}/docker-compose.yml" exec -T db psql -U postgres -v ON_ERROR_STOP=1 -d "${DB}" -q < "$1"; }
else
  export PGUSER="${PGUSER:-postgres}"
  send() { command psql -v ON_ERROR_STOP=1 -d "${DB}" -q -f "$1"; }
fi

psql -d "${DB}" -q -c "
  create table if not exists schema_migration (
    filename text primary key,
    applied_at timestamptz not null default now(),
    checksum text
  );"

applied="$(psql -d "${DB}" -tAc 'select filename from schema_migration' | tr -d '\r')"

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

for path in "${MIGRATIONS}"/0*.sql; do
  file="$(basename "${path}")"
  # 002 is the invariant check and 0*_seed* is demo data; neither is schema.
  case "${file}" in 002_*|*seed*) continue ;; esac
  if echo "${applied}" | grep -qx "${file}"; then
    echo "  skip ${file}"
    continue
  fi
  echo "==> ${file}"
  send "${path}"
  record_migration "${file}" "${path}"
done

# 001 creates link_erp_app with no password, because a password is a
# deployment concern rather than a schema one. Nothing then set it, so the API
# could not connect at all — the documented deploy path did not work until this
# ran here.
if [ -n "${APP_DB_PASSWORD:-}" ]; then
  psql -d "${DB}" -q -v app_db_password="${APP_DB_PASSWORD}" <<'SQL'
alter role link_erp_app login password :'app_db_password';
SQL
  echo "==> app role password set"
else
  echo "==> APP_DB_PASSWORD not set; leaving the app role's password alone" >&2
fi

echo "==> $(psql -d "${DB}" -tAc 'select count(*) from schema_migration' | tr -d ' ') migrations recorded"
