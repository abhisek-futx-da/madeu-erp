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
HERE="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib-release.sh
source "${HERE}/scripts/lib-release.sh"

[ -f "${FILE}" ] || { echo "no such file: ${FILE}" >&2; exit 1; }

# An encrypted archive is decrypted to a private temp file first. The plaintext
# never outlives this script, and never lands next to the ciphertext.
if [ "${FILE%.gpg}" != "${FILE}" ]; then
  command -v gpg > /dev/null || { echo "this archive is encrypted and gpg is not installed" >&2; exit 1; }
  PLAIN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/link-erp-restore.XXXXXX")"
  chmod 700 "${PLAIN_DIR}"
  trap 'rm -rf -- "${PLAIN_DIR}"' EXIT
  PLAIN="${PLAIN_DIR}/$(basename "${FILE%.gpg}")"
  if [ -n "${BACKUP_PASSPHRASE:-}" ]; then
    printf '%s' "${BACKUP_PASSPHRASE}" | gpg --batch --quiet --passphrase-fd 0 \
      --pinentry-mode loopback --output "${PLAIN}" --decrypt "${FILE}"
  else
    gpg --batch --quiet --output "${PLAIN}" --decrypt "${FILE}"
  fi
  [ -s "${PLAIN}" ] || { echo "could not decrypt ${FILE}" >&2; exit 1; }
  FILE="${PLAIN}"
fi
# Database names are interpolated only where PostgreSQL cannot parameterise an
# identifier. Refuse anything except an ordinary identifier before doing so.
[[ "${TARGET}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || { echo "invalid target database name" >&2; exit 1; }
[[ "${DB_LIVE}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || { echo "invalid live database name" >&2; exit 1; }

# Use the compose database when that is the active deployment.  CI and local
# test stacks set PGHOST, so they use their explicitly selected Postgres.
if [ -z "${PGHOST:-}" ] && docker compose -f "${HERE}/docker-compose.yml" ps db --status running >/dev/null 2>&1; then
  PSQL=(docker compose -f "${HERE}/docker-compose.yml" exec -T db psql -U postgres)
  RESTORE=(docker compose -f "${HERE}/docker-compose.yml" exec -T db pg_restore -U postgres)
  verify_archive() { cat "${FILE}" | "${RESTORE[@]}" --list > /dev/null; }
  restore_archive() { cat "${FILE}" | "${RESTORE[@]}" -d "${TARGET}" --no-owner --role=postgres; }
else
  PSQL=(psql -U postgres)
  select_pg_archive_mode "${DB_LIVE}"
  if [ -n "${PG_ARCHIVE_IMAGE_SELECTED}" ]; then
    verify_archive() { docker_pg_archive pg_restore --list < "${FILE}" > /dev/null; }
    restore_archive() { docker_pg_archive pg_restore -d "${TARGET}" --no-owner --role=postgres < "${FILE}"; }
  else
    RESTORE=(pg_restore -U postgres)
    verify_archive() { "${RESTORE[@]}" --list "${FILE}" > /dev/null; }
    restore_archive() { "${RESTORE[@]}" -d "${TARGET}" --no-owner --role=postgres "${FILE}"; }
  fi
fi

verify_archive || { echo "not a readable archive" >&2; exit 1; }

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
"${PSQL[@]}" -q -d postgres \
  -c "drop database if exists ${TARGET};" \
  -c "create database ${TARGET};"

echo "==> restoring"
restore_archive

echo "==> checking the restore is usable"
"${PSQL[@]}" -q -d "${TARGET}" -v ON_ERROR_STOP=1 <<'SQL'
do $$
declare migrations integer; tenants integer; bad_vouchers integer; drifted_pieces integer;
begin
  select count(*) into migrations from schema_migration;
  if migrations = 0 then raise exception 'restore contains no migration history'; end if;
  select count(*) into tenants from tenant;
  if tenants = 0 then raise exception 'restore contains no companies'; end if;
  select count(*) into bad_vouchers from (
    select v.id from voucher v join voucher_line line on line.voucher_id = v.id
     where v.is_posted group by v.id having abs(sum(line.debit - line.credit)) >= 0.01
  ) bad;
  if bad_vouchers > 0 then raise exception 'restore contains % unbalanced posted voucher(s)', bad_vouchers; end if;
  select count(*) into drifted_pieces from piece p
   join lateral (select m.to_status, m.qty_after from piece_movement m
                  where m.piece_id = p.id order by m.id desc limit 1) last on true
   where p.status <> last.to_status or p.current_qty <> last.qty_after;
  if drifted_pieces > 0 then raise exception 'restore contains % piece movement drift(s)', drifted_pieces; end if;
  raise notice 'restore verified: % migration(s), % tenant(s), balanced vouchers, no piece drift',
    migrations, tenants;
end $$;
SQL

echo "restored into ${TARGET}"
