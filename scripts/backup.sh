#!/usr/bin/env bash
#
# Nightly backup. A mill's books are the business; losing them is not a bug you
# can fix on Monday.
#
#   ./scripts/backup.sh                 # into ./backups
#   RETAIN_DAYS=30 ./scripts/backup.sh  # keep a month
#
# Add to cron on the host:
#   15 22 * * * cd /srv/link-erp && ./scripts/backup.sh >> /var/log/link-erp-backup.log 2>&1
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${BACKUP_DIR:-${HERE}/backups}"
RETAIN_DAYS="${RETAIN_DAYS:-14}"
DB="${POSTGRES_DB:-linkerp}"
STAMP="$(date +%Y%m%d-%H%M%S)"
FILE="${OUT}/${DB}-${STAMP}.dump"

[[ "${DB}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || { echo "invalid database name" >&2; exit 1; }

mkdir -p "${OUT}"

# -Fc is the custom format: compressed, and pg_restore can pull a single table
# out of it, which is what you actually want at 2am.
if [ -z "${PGHOST:-}" ] && docker compose -f "${HERE}/docker-compose.yml" ps db --status running >/dev/null 2>&1; then
  docker compose -f "${HERE}/docker-compose.yml" exec -T db \
    pg_dump -U postgres -d "${DB}" -Fc > "${FILE}"
else
  pg_dump -d "${DB}" -Fc > "${FILE}"
fi

# A backup nobody checked is a backup nobody has. Verify the archive lists.
if [ -z "${PGHOST:-}" ] && docker compose -f "${HERE}/docker-compose.yml" ps db --status running >/dev/null 2>&1; then
  verify_archive() { cat "${FILE}" | docker compose -f "${HERE}/docker-compose.yml" exec -T db pg_restore --list > /dev/null; }
else
  verify_archive() { pg_restore --list "${FILE}" > /dev/null; }
fi
if ! verify_archive 2>/dev/null; then
  echo "FAILED: ${FILE} is not a readable archive" >&2
  rm -f "${FILE}"
  exit 1
fi

SIZE="$(du -h "${FILE}" | cut -f1)"
echo "$(date -Iseconds) ok ${FILE} (${SIZE})"

# Prune, but never leave zero backups behind because of a clock problem.
KEPT="$(find "${OUT}" -name "${DB}-*.dump" -type f | wc -l | tr -d ' ')"
if [ "${KEPT}" -gt 3 ]; then
  find "${OUT}" -name "${DB}-*.dump" -type f -mtime "+${RETAIN_DAYS}" -delete
fi
