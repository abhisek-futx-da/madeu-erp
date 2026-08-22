#!/usr/bin/env bash
#
# Proves a fresh backup can be restored into a new, non-production database.
# This is safe to run before a pilot: it never targets the live database.

set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
DB="${POSTGRES_DB:-linkerp}"
STAMP="$(date +%Y%m%d%H%M%S)"
TARGET="${DB}_restore_check_${STAMP}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/link-erp-restore.XXXXXX")"
trap 'rm -rf -- "$WORK"' EXIT

echo "==> backing up ${DB}"
BACKUP_DIR="${WORK}" "${HERE}/scripts/backup.sh"
DUMP="$(find "${WORK}" -maxdepth 1 -type f -name "${DB}-*.dump" -print -quit)"
[ -n "${DUMP}" ] || { echo "backup did not create an archive" >&2; exit 1; }

echo "==> restoring into non-production database ${TARGET}"
"${HERE}/scripts/restore.sh" "${DUMP}" "${TARGET}"
echo "backup restore drill passed: ${TARGET}"
