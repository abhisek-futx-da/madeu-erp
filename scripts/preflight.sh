#!/usr/bin/env bash
#
# Refuses the common "it worked on localhost" production mistakes before a
# pilot machine is exposed.  It checks configuration only; a green result is
# not a substitute for the clean test suite, CA review, or a restore drill.
#
#   ENV_FILE=.env.production ./scripts/preflight.sh

set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${ENV_FILE:-${HERE}/.env}"
FAIL=0

[ -f "${ENV_FILE}" ] || { echo "missing environment file: ${ENV_FILE}" >&2; exit 2; }

# Do not source an environment file: deployment secrets are data, not shell
# code.  Compose accepts simple KEY=VALUE entries, which is the format this
# checker intentionally supports.
value() {
  local key="$1" line
  line="$(grep -E "^${key}=" "${ENV_FILE}" | tail -n 1 || true)"
  line="${line#*=}"
  line="${line%$'\r'}"
  if [[ "${line}" =~ ^\".*\"$ || "${line}" =~ ^\'.*\'$ ]]; then
    line="${line:1:${#line}-2}"
  fi
  printf '%s' "${line}"
}

ok() { printf '  ok    %s\n' "$1"; }
bad() { printf '  FAIL  %s\n' "$1" >&2; FAIL=1; }

secret() {
  local key="$1" min="$2" val
  val="$(value "${key}")"
  if [ "${#val}" -lt "${min}" ] || [[ "${val}" == *change-me* ]] || [[ "${val}" == *example* ]] || [[ "${val}" == *replace-with* ]]; then
    bad "${key} must be a unique secret of at least ${min} characters"
  else
    ok "${key} is present and not a template value"
  fi
}

printf 'Link ERP controlled-pilot deployment preflight\n'
secret POSTGRES_PASSWORD 24
secret APP_DB_PASSWORD 24
secret JWT_SECRET 32
KEY_ID="$(value JWT_KEY_ID)"
if [[ "${KEY_ID}" =~ ^[A-Za-z0-9._-]{1,40}$ ]]; then
  ok "JWT_KEY_ID is a short log-safe identifier"
else
  bad "JWT_KEY_ID must contain only letters, numbers, dot, underscore, or hyphen"
fi
PREVIOUS_KEYS="$(value JWT_PREVIOUS_SECRETS)"
if [ -n "${PREVIOUS_KEYS}" ]; then
  PREVIOUS_OK=true
  IFS=',' read -r -a previous_parts <<< "${PREVIOUS_KEYS}"
  for previous in "${previous_parts[@]}"; do
    previous="${previous#${previous%%[![:space:]]*}}"
    previous="${previous%${previous##*[![:space:]]}}"
    if [ "${#previous}" -lt 32 ] || [ "${previous}" = "$(value JWT_SECRET)" ]; then
      bad "every JWT_PREVIOUS_SECRETS entry must be a distinct 32-plus-character former key"
      PREVIOUS_OK=false
      break
    fi
  done
  [ "${PREVIOUS_OK}" != true ] || ok "previous JWT keys are valid for a bounded rotation window"
else
  ok "no previous JWT signing key is retained"
fi
MFA_KEY="$(value MFA_ENCRYPTION_KEY)"
if [[ "${MFA_KEY}" =~ ^[A-Za-z0-9+/]{43}=$ ]]; then
  ok "MFA_ENCRYPTION_KEY is a base64-encoded 32-byte key"
else
  bad "MFA_ENCRYPTION_KEY must be generated with: openssl rand -base64 32"
fi

POSTGRES_SECRET="$(value POSTGRES_PASSWORD)"
APP_SECRET="$(value APP_DB_PASSWORD)"
JWT_VALUE="$(value JWT_SECRET)"
if [ "${POSTGRES_SECRET}" = "${APP_SECRET}" ] || [ "${POSTGRES_SECRET}" = "${JWT_VALUE}" ] \
   || [ "${APP_SECRET}" = "${JWT_VALUE}" ] || [ "${MFA_KEY}" = "${POSTGRES_SECRET}" ] \
   || [ "${MFA_KEY}" = "${APP_SECRET}" ] || [ "${MFA_KEY}" = "${JWT_VALUE}" ]; then
  bad "database, signing, and MFA encryption secrets must all be different"
else
  ok "database and signing secrets are independent"
fi

if [ "$(value FORCE_HTTPS)" = "true" ]; then
  ok "FORCE_HTTPS=true"
else
  bad "FORCE_HTTPS must be true behind a real TLS reverse proxy"
fi

ORIGIN="$(value CORS_ORIGIN)"
if [[ "${ORIGIN}" =~ ^https://[^/]+$ ]] && [[ "${ORIGIN}" != *localhost* ]] \
   && [[ "${ORIGIN}" != *example* ]] && [[ "${ORIGIN}" != *yourmill* ]]; then
  ok "CORS_ORIGIN is one explicit HTTPS browser origin"
else
  bad "CORS_ORIGIN must be the public HTTPS origin, for example https://erp.example.in"
fi

RATE="$(value RATE_LIMIT_PER_MINUTE)"
if [[ "${RATE}" =~ ^[1-9][0-9]*$ ]] && [ "${RATE}" -le 10000 ]; then
  ok "RATE_LIMIT_PER_MINUTE is a bounded positive integer"
else
  bad "RATE_LIMIT_PER_MINUTE must be a positive integer no greater than 10000"
fi
if [ "$(value RATE_LIMIT_MODE)" = "database" ]; then
  ok "general API rate limiting is shared across replicas"
else
  bad "RATE_LIMIT_MODE must be database for a controlled pilot"
fi

if [ "$(value LOG_REQUESTS)" = "true" ]; then
  ok "structured request logging is enabled"
else
  bad "LOG_REQUESTS must be true for a pilot"
fi

WA_VERSION="$(value WHATSAPP_GRAPH_VERSION)"
WA_PHONE="$(value WHATSAPP_PHONE_NUMBER_ID)"
WA_TOKEN="$(value WHATSAPP_ACCESS_TOKEN)"
if [ -z "${WA_VERSION}${WA_PHONE}${WA_TOKEN}" ]; then
  ok "WhatsApp delivery is explicitly disabled"
elif [[ "${WA_VERSION}" =~ ^v[0-9]+\.[0-9]+$ ]] \
  && [[ "${WA_PHONE}" =~ ^[0-9]{6,30}$ ]] && [ "${#WA_TOKEN}" -ge 20 ] \
  && [ -n "$(value WHATSAPP_INVOICE_TEMPLATE)" ] \
  && [ -n "$(value WHATSAPP_PAYMENT_REMINDER_TEMPLATE)" ]; then
  ok "WhatsApp provider settings are complete (live delivery still needs provider acceptance)"
else
  bad "WhatsApp settings must be all blank or a complete Graph version, phone ID, token, and both templates"
fi

PRINT_BRIDGE="$(value VITE_PRINT_BRIDGE_URL)"
SCALE_BRIDGE="$(value VITE_SCALE_BRIDGE_URL)"
BRIDGE_TOKEN="$(value HARDWARE_BRIDGE_TOKEN)"
if [ -z "${PRINT_BRIDGE}${SCALE_BRIDGE}${BRIDGE_TOKEN}" ]; then
  ok "local hardware bridge is explicitly disabled"
elif [[ "${PRINT_BRIDGE}" =~ ^http://(127\.0\.0\.1|localhost):[0-9]+/print$ ]] \
  && [[ "${SCALE_BRIDGE}" =~ ^http://(127\.0\.0\.1|localhost):[0-9]+/scale$ ]] \
  && [ "${#BRIDGE_TOKEN}" -ge 24 ] && [[ "${BRIDGE_TOKEN}" != *replace-with* ]]; then
  ok "hardware bridge is loopback-only and has a non-template pairing token"
else
  bad "hardware bridge URLs must be loopback /print and /scale endpoints with a 24-plus-character pairing token"
fi

BACKUP_DIR="$(value BACKUP_DIR)"
if [[ "${BACKUP_DIR}" = /* ]] && [ "${BACKUP_DIR}" != "${HERE}" ] && [[ "${BACKUP_DIR}" != "${HERE}/"* ]] \
   && [ -d "${BACKUP_DIR}" ] && [ -w "${BACKUP_DIR}" ]; then
  ok "backup path is outside the application checkout"
else
  bad "BACKUP_DIR must be an existing writable absolute path outside the application checkout"
fi
if [ "$(value BACKUP_OFFSITE_CONFIRMED)" = "true" ]; then
  ok "off-device backup copy is explicitly confirmed"
else
  bad "BACKUP_OFFSITE_CONFIRMED must be true after independent storage is configured"
fi

HEALTH="$(value HEALTHCHECK_URL)"
ALERT="$(value ALERT_WEBHOOK_URL)"
[[ "${HEALTH}" =~ ^https://[^/]+/.+ ]] && [[ "${HEALTH}" != *example* ]] && [[ "${HEALTH}" != *yourmill* ]] && ok "public HTTPS health monitor target is configured" \
  || bad "HEALTHCHECK_URL must be the public HTTPS /health endpoint"
[[ "${ALERT}" =~ ^https://[^/]+/.+ ]] && [[ "${ALERT}" != *example* ]] && ok "failure alert webhook is configured" \
  || bad "ALERT_WEBHOOK_URL must be a protected HTTPS endpoint"

RELEASE_TAG="$(value RELEASE_TAG)"
if [[ "${RELEASE_TAG}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9.-]+)?$ ]] \
   && [[ "${RELEASE_TAG}" != *replace* ]]; then
  ok "release tag has a versioned name"
else
  bad "RELEASE_TAG must be a version such as v1.0.0"
fi

if [ -d "${HERE}/.git" ]; then
  if [ -z "$(git -C "${HERE}" status --porcelain --untracked-files=normal)" ]; then
    ok "release checkout is clean"
  else
    bad "release checkout has modified or untracked files"
  fi
  ACTUAL_TAG="$(git -C "${HERE}" describe --tags --exact-match HEAD 2>/dev/null || true)"
  if [ -n "${RELEASE_TAG}" ] && [ "${ACTUAL_TAG}" = "${RELEASE_TAG}" ]; then
    ok "RELEASE_TAG points at the exact checked-out commit"
  else
    bad "checked-out commit must be tagged exactly as RELEASE_TAG (${RELEASE_TAG})"
  fi
fi

if command -v docker >/dev/null 2>&1 && docker compose --env-file "${ENV_FILE}" -f "${HERE}/docker-compose.yml" config -q >/dev/null; then
  ok "docker compose accepts this configuration"
else
  bad "docker compose could not validate this configuration"
fi

if [ "${FAIL}" -ne 0 ]; then
  echo "Preflight failed. Do not expose this deployment yet." >&2
  exit 1
fi

cat <<'MSG'

Configuration gate passed. Before a real pilot, also run the clean release
suite, make an independent backup, restore it to a separate database, and
confirm that TLS terminates in front of the web container.
MSG
