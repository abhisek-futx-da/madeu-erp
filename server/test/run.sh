#!/usr/bin/env bash
#
# Runs the suite against a database built from scratch.
#
# The audit's sharpest finding about testing was that the tests asserted over
# one shared, accumulating database: aggregate assertions drifted as the demo
# data grew, credit limits filled up, and ordinary use of the app broke the
# suite. Twenty of a hundred and thirty-one tests failed after four documents
# were created by hand. A run now starts from a known database every time.
#
# Usage: PGHOST=... PGPORT=... PGUSER=postgres ./test/run.sh [pattern]
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SERVER="$(dirname "$HERE")"
DB="${TEST_DB:-linkerp_test}"
PORT="${TEST_PORT:-4111}"

: "${PGHOST:?set PGHOST to the Postgres socket or host}"
: "${PGPORT:?set PGPORT}"
export PGUSER="${PGUSER:-postgres}"

echo "==> rebuilding ${DB}"
# rebuild.sh exits non-zero when an invariant fails. Piping it into grep would
# hide that behind grep's own status and hand the suite a database already
# known to be wrong, so its output is captured and its status checked.
if ! REBUILD="$("${SERVER}/../link-erp/db/rebuild.sh" "${DB}" 2>&1)"; then
  printf '%s\n' "${REBUILD}" >&2
  echo "the database did not build cleanly" >&2
  exit 1
fi
printf '%s\n' "${REBUILD}" | grep -E 'invariants:|FAIL' || true

# PostgreSQL roles are cluster-wide, while each suite rebuilds only its own
# database. The browser gate also uses link_erp_app and deliberately changes
# its password; provision this suite's credential every run so gate order can
# never decide whether /health starts.
TEST_APP_PASSWORD='server-test-only-password'
psql -q -v ON_ERROR_STOP=1 -d "${DB}" -v app_db_password="${TEST_APP_PASSWORD}" <<'SQL'
alter role link_erp_app login password :'app_db_password';
SQL

export DATABASE_URL="postgresql://link_erp_app:${TEST_APP_PASSWORD}@/${DB}?host=${PGHOST}&port=${PGPORT}"
export JWT_SECRET="${JWT_SECRET:-test-only-secret}"
export JWT_KEY_ID="${JWT_KEY_ID:-test-current}"
export JWT_PREVIOUS_SECRETS="${JWT_PREVIOUS_SECRETS:-test-only-previous-secret-at-least-32-characters-long}"
export MFA_ENCRYPTION_KEY="${MFA_ENCRYPTION_KEY:-MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA=}"
export PORT="${PORT}"
export API_BASE="http://127.0.0.1:${PORT}"
export LOG_REQUESTS=false
# The whole suite is one deliberately serial API process.  Its aggregate
# request count is not an abusive client, so keep the production limiter out
# of unrelated test outcomes; login throttling remains at its real setting.
export RATE_LIMIT_PER_MINUTE="${RATE_LIMIT_PER_MINUTE:-10000}"
export RATE_LIMIT_MODE="${RATE_LIMIT_MODE:-database}"
# Metrics refuse to serve without a token, so the suite has to configure one
# before it can prove either the refusal or the numbers.
export METRICS_TOKEN="${METRICS_TOKEN:-test-only-metrics-token}"

echo "==> starting the api on :${PORT}"
node --experimental-strip-types "${SERVER}/src/index.ts" > /tmp/link-erp-test-api.log 2>&1 &
API_PID=$!
# The server is up when it answers, not when the process exists.
trap 'kill ${API_PID} 2>/dev/null || true' EXIT
for _ in $(seq 1 40); do
  if curl -fsS -m 1 "${API_BASE}/health" > /dev/null 2>&1; then break; fi
  sleep 0.25
done
if ! curl -fsS -m 2 "${API_BASE}/health" > /dev/null; then
  echo "the api did not come up:"; tail -20 /tmp/link-erp-test-api.log; exit 1
fi

echo "==> running the suite"
if [ $# -gt 0 ]; then
  node --experimental-strip-types --test-concurrency=1 --test "${HERE}"/*"$1"*.test.ts
else
  node --experimental-strip-types --test-concurrency=1 --test "${HERE}"/*.test.ts
fi
