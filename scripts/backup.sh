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
# shellcheck source=lib-release.sh
source "${HERE}/scripts/lib-release.sh"
OUT="${BACKUP_DIR:-${HERE}/backups}"
RETAIN_DAYS="${RETAIN_DAYS:-14}"
DB="${POSTGRES_DB:-linkerp}"
STAMP="$(date +%Y%m%d-%H%M%S)"
FILE="${OUT}/${DB}-${STAMP}.dump"

[[ "${DB}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || { echo "invalid database name" >&2; exit 1; }

mkdir -p "${OUT}"

ARCHIVE_MODE=local
if [ -z "${PGHOST:-}" ] && docker compose -f "${HERE}/docker-compose.yml" ps db --status running >/dev/null 2>&1; then
  ARCHIVE_MODE=compose
else
  select_pg_archive_mode "${DB}"
  [ -z "${PG_ARCHIVE_IMAGE_SELECTED}" ] || ARCHIVE_MODE=image
fi

# -Fc is the custom format: compressed, and pg_restore can pull a single table
# out of it, which is what you actually want at 2am.
if [ "${ARCHIVE_MODE}" = compose ]; then
  docker compose -f "${HERE}/docker-compose.yml" exec -T db \
    pg_dump -U postgres -d "${DB}" -Fc > "${FILE}"
elif [ "${ARCHIVE_MODE}" = image ]; then
  docker_pg_archive pg_dump -d "${DB}" -Fc > "${FILE}"
else
  pg_dump -d "${DB}" -Fc > "${FILE}"
fi

# A backup nobody checked is a backup nobody has. Verify the archive lists.
if [ "${ARCHIVE_MODE}" = compose ]; then
  verify_archive() { cat "${FILE}" | docker compose -f "${HERE}/docker-compose.yml" exec -T db pg_restore --list > /dev/null; }
elif [ "${ARCHIVE_MODE}" = image ]; then
  verify_archive() { docker_pg_archive pg_restore --list < "${FILE}" > /dev/null; }
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
