#!/usr/bin/env bash
# Runs the real browser gate against a fresh isolated database and temporary
# API/web processes. Nothing uses the developer's preview or business data.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DB="${E2E_DB:-linkerp_e2e}"
API_PORT="${E2E_API_PORT:-4012}"
WEB_PORT="${E2E_WEB_PORT:-3012}"
APP_PASSWORD="${E2E_APP_PASSWORD:-e2e-only-password}"
API_LOG="${TMPDIR:-/tmp}/link-erp-e2e-api.log"
WEB_LOG="${TMPDIR:-/tmp}/link-erp-e2e-web.log"
[[ "${DB}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || { echo "invalid E2E database name" >&2; exit 2; }

API_PID=''; WEB_PID=''
cleanup() {
  [ -z "${API_PID}" ] || kill "${API_PID}" 2>/dev/null || true
  [ -z "${WEB_PID}" ] || kill "${WEB_PID}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Use the same database transport as the server suite.  Local development uses
# a private Unix socket; hardcoding 127.0.0.1 made health checks intermittently
# hang even though PostgreSQL was healthy on its configured socket.  Hosted CI
# still uses its ordinary TCP host and the isolated password below.
if [[ "${PGHOST:-}" == /* ]]; then
  E2E_DATABASE_URL="postgresql://link_erp_app@/${DB}?host=${PGHOST}&port=${PGPORT:-5432}"
else
  E2E_DATABASE_URL="postgresql://link_erp_app:${APP_PASSWORD}@${PGHOST:-127.0.0.1}:${PGPORT:-5432}/${DB}"
fi

"${ROOT}/link-erp/db/rebuild.sh" "${DB}" >/dev/null
psql -q -v ON_ERROR_STOP=1 -d "${DB}" -c "alter role link_erp_app password '${APP_PASSWORD}'"

DATABASE_URL="${E2E_DATABASE_URL}" \
JWT_SECRET='e2e-only-secret-not-used-anywhere-real' \
MFA_ENCRYPTION_KEY='MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA=' \
CORS_ORIGIN="http://127.0.0.1:${WEB_PORT}" PORT="${API_PORT}" LOG_REQUESTS=false \
  npm --prefix "${ROOT}/server" start >"${API_LOG}" 2>&1 &
API_PID=$!

VITE_API_BASE="http://127.0.0.1:${API_PORT}" \
  npm --prefix "${ROOT}/link-erp" run dev -- --host 127.0.0.1 --port "${WEB_PORT}" \
  >"${WEB_LOG}" 2>&1 &
WEB_PID=$!

ready=false
# A cold laptop may be building containers or scanning dependencies while this
# isolated stack starts.  Fifteen seconds made the release gate flaky even
# though both services became healthy immediately afterwards.  Readiness is a
# condition, not a race: allow up to one minute and still fail decisively.
for _ in $(seq 1 120); do
  if curl -fsS -m 1 "http://127.0.0.1:${API_PORT}/health" >/dev/null 2>&1 \
     && curl -fsS -m 1 "http://127.0.0.1:${WEB_PORT}" >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 0.5
done
if [ "${ready}" != true ]; then
  echo "browser stack did not become ready" >&2
  tail -40 "${API_LOG}" "${WEB_LOG}" >&2 || true
  exit 1
fi

if ! E2E_BASE_URL="http://127.0.0.1:${WEB_PORT}" npm --prefix "${ROOT}/link-erp" run test:e2e; then
  tail -60 "${API_LOG}" "${WEB_LOG}" >&2 || true
  exit 1
fi
