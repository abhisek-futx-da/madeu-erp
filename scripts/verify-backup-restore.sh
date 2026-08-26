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
DUMP="$(find "${WORK}" -maxdepth 1 -type f \
          \( -name "${DB}-*.dump" -o -name "${DB}-*.dump.gpg" \) -print -quit)"
[ -n "${DUMP}" ] || { echo "backup did not create an archive" >&2; exit 1; }

echo "==> restoring into non-production database ${TARGET}"
"${HERE}/scripts/restore.sh" "${DUMP}" "${TARGET}"
echo "backup restore drill passed: ${TARGET}"

# The encrypted archive is the one a pilot actually ships offsite, so the drill
# has to prove that round trip too — encrypt, mirror, decrypt, restore.
if command -v gpg > /dev/null; then
  echo "==> encrypted archive and offsite mirror"
  ENC_WORK="$(mktemp -d "${TMPDIR:-/tmp}/link-erp-enc.XXXXXX")"
  MIRROR="${ENC_WORK}/offsite"
  trap 'rm -rf -- "$WORK" "$ENC_WORK"' EXIT
  # Never echoed, never written to disk: it lives in this shell and gpg's stdin.
  PASS="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"

  BACKUP_DIR="${ENC_WORK}" BACKUP_PASSPHRASE="${PASS}" BACKUP_MIRROR_DIR="${MIRROR}" \
    "${HERE}/scripts/backup.sh"

  ENC="$(find "${ENC_WORK}" -maxdepth 1 -type f -name "${DB}-*.dump.gpg" -print -quit)"
  [ -n "${ENC}" ] || { echo "encryption produced no archive" >&2; exit 1; }
  find "${ENC_WORK}" -maxdepth 1 -type f -name "${DB}-*.dump" | grep -q . \
    && { echo "the plaintext archive was left behind" >&2; exit 1; }
  [ -f "${MIRROR}/$(basename "${ENC}")" ] || { echo "nothing reached the mirror" >&2; exit 1; }

  ENC_TARGET="${DB}_restore_enc_${STAMP}"
  BACKUP_PASSPHRASE="${PASS}" "${HERE}/scripts/restore.sh" \
    "${MIRROR}/$(basename "${ENC}")" "${ENC_TARGET}"
  echo "encrypted offsite restore drill passed: ${ENC_TARGET}"
else
  echo "gpg is not installed; encrypted offsite restore proof is mandatory" >&2
  exit 1
fi
