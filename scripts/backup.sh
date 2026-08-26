#!/usr/bin/env bash
#
# Nightly backup. A mill's books are the business; losing them is not a bug you
# can fix on Monday.
#
#   ./scripts/backup.sh                 # into ./backups
#   RETAIN_DAYS=30 ./scripts/backup.sh  # keep a month
#
# Getting it off the machine, which is the whole point of a backup:
#   BACKUP_RECIPIENT=ops@example.com    # encrypt to a GPG public key (preferred:
#                                       # no secret sits on the server)
#   BACKUP_PASSPHRASE=...               # or symmetric AES256, if you have no key
#   BACKUP_MIRROR_DIR=/mnt/offsite      # a second destination: mounted bucket,
#                                       # NFS share, or a disk that leaves the building
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

# ------------------------------------------------------------- encryption --
#
# Asking for encryption and silently getting plaintext is worse than not asking,
# so a missing gpg is a failure here rather than a warning nobody reads.
ARTIFACT="${FILE}"
if [ -n "${BACKUP_RECIPIENT:-}" ] || [ -n "${BACKUP_PASSPHRASE:-}" ]; then
  command -v gpg > /dev/null || {
    echo "FAILED: encryption was requested but gpg is not installed" >&2
    rm -f "${FILE}"; exit 1; }

  if [ -n "${BACKUP_RECIPIENT:-}" ]; then
    gpg --batch --yes --trust-model always --recipient "${BACKUP_RECIPIENT}" \
        --output "${FILE}.gpg" --encrypt "${FILE}"
  else
    # The passphrase reaches gpg on a pipe, never in argv, which `ps` shows.
    printf '%s' "${BACKUP_PASSPHRASE}" | gpg --batch --yes --passphrase-fd 0 \
        --pinentry-mode loopback --symmetric --cipher-algo AES256 \
        --output "${FILE}.gpg" "${FILE}"
  fi

  # Verify what will actually be kept. Checking the plaintext and then shipping
  # an unopened ciphertext is how people discover their backups at the worst
  # possible moment.
  if [ -n "${BACKUP_PASSPHRASE:-}" ]; then
    DECRYPT() { printf '%s' "${BACKUP_PASSPHRASE}" | gpg --batch --quiet --passphrase-fd 0 \
                  --pinentry-mode loopback --decrypt "${FILE}.gpg"; }
  else
    DECRYPT() { gpg --batch --quiet --decrypt "${FILE}.gpg"; }
  fi
  if ! DECRYPT 2>/dev/null | cmp -s - "${FILE}"; then
    echo "FAILED: ${FILE}.gpg does not decrypt back to the archive" >&2
    rm -f "${FILE}" "${FILE}.gpg"; exit 1
  fi

  rm -f "${FILE}"
  ARTIFACT="${FILE}.gpg"
else
  echo "$(date -Iseconds) warn ${FILE} is NOT encrypted; set BACKUP_RECIPIENT or BACKUP_PASSPHRASE" >&2
fi

SIZE="$(du -h "${ARTIFACT}" | cut -f1)"
echo "$(date -Iseconds) ok ${ARTIFACT} (${SIZE})"

# ---------------------------------------------------------------- offsite --
#
# A copy on the same disk as the database is not a backup; it is a second file
# that dies with the first. The mirror is an ordinary path so it can be a
# mounted bucket, an NFS share, or a disk somebody carries home.
if [ -n "${BACKUP_MIRROR_DIR:-}" ]; then
  mkdir -p "${BACKUP_MIRROR_DIR}"
  cp "${ARTIFACT}" "${BACKUP_MIRROR_DIR}/"
  MIRRORED="${BACKUP_MIRROR_DIR}/$(basename "${ARTIFACT}")"
  cmp -s "${ARTIFACT}" "${MIRRORED}" || {
    echo "FAILED: the offsite copy does not match the archive" >&2; exit 1; }
  echo "$(date -Iseconds) ok mirrored to ${MIRRORED}"
else
  echo "$(date -Iseconds) warn no BACKUP_MIRROR_DIR; this archive never leaves the machine" >&2
fi

# Prune, but never leave zero backups behind because of a clock problem.
KEPT="$(find "${OUT}" \( -name "${DB}-*.dump" -o -name "${DB}-*.dump.gpg" \) -type f | wc -l | tr -d ' ')"
if [ "${KEPT}" -gt 3 ]; then
  find "${OUT}" \( -name "${DB}-*.dump" -o -name "${DB}-*.dump.gpg" \) \
       -type f -mtime "+${RETAIN_DAYS}" -delete
fi
