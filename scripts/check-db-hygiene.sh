#!/usr/bin/env bash
# Release-time database hygiene checks. SQL errors are fatal; an empty result
# is accepted only after psql itself succeeds.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DB="${1:-linkerp_test}"
[[ "${DB}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || { echo "invalid database name" >&2; exit 2; }

RECORDED="$(psql -v ON_ERROR_STOP=1 -d "${DB}" -tAc 'select count(*) from schema_migration' | tr -d ' ')"
FILES="$(find "${ROOT}/link-erp/db" -maxdepth 1 -name '0*.sql' \
  | grep -vE '00[23]_|seed' | wc -l | tr -d ' ')"
echo "migrations recorded=${RECORDED} files=${FILES}"
[ "${RECORDED}" = "${FILES}" ] || { echo "migration ledger does not match the release" >&2; exit 1; }

MISSING="$(psql -v ON_ERROR_STOP=1 -d "${DB}" -tAc "
  select coalesce(string_agg(fk, ', '), '')
    from (
      select c.conrelid::regclass::text || '.' || a.attname as fk
        from pg_constraint c
        join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
       where c.contype = 'f'
         and c.connamespace = 'public'::regnamespace
         and a.attname not in
             ('created_by','closed_by','filed_by','reopened_by','approved_by')
         and not exists (
           select 1 from pg_index i
            where i.indrelid = c.conrelid
              and (i.indkey[0] = c.conkey[1]
                   or (i.indkey[1] = c.conkey[1]
                       and i.indkey[0] = (select attnum from pg_attribute
                                           where attrelid = c.conrelid
                                             and attname = 'tenant_id'))))
    ) missing
")"
MISSING="$(printf '%s' "${MISSING}" | xargs)"
echo "unindexed foreign keys: ${MISSING:-none}"
[ -z "${MISSING}" ] || exit 1
