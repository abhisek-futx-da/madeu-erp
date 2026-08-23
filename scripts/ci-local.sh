#!/usr/bin/env bash
#
# Runs every step the GitHub workflow runs, here, against a real Postgres.
#
# A workflow file that has never executed is a plausible-looking guess. This
# exists so the pipeline can be proven on a laptop before anyone trusts a green
# tick on a pull request, and so a failure is debuggable without pushing.
#
#   PGHOST=... PGPORT=... PGUSER=postgres ./scripts/ci-local.sh
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
: "${PGHOST:?set PGHOST}"; : "${PGPORT:?set PGPORT}"
export PGUSER="${PGUSER:-postgres}"
export JWT_SECRET="${JWT_SECRET:-ci-only-secret-not-used-anywhere-real}"

PASS=0; FAIL=0
step() {
  local name="$1"; shift
  printf '\n\033[1m==> %s\033[0m\n' "${name}"
  if "$@" > /tmp/ci-step.log 2>&1; then
    printf '    \033[32mok\033[0m\n'; PASS=$((PASS + 1))
  else
    printf '    \033[31mFAILED\033[0m\n'; tail -25 /tmp/ci-step.log; FAIL=$((FAIL + 1))
  fi
}

# ---------------------------------------------------------------- server --

step "server: install"        bash -c "cd '${ROOT}/server' && npm ci --silent"
step "server: typecheck"      bash -c "cd '${ROOT}/server' && npm run typecheck"
step "server: tests on a database built from scratch" \
                              bash -c "cd '${ROOT}/server' && ./test/run.sh"
step "server: production dependency audit" \
                              bash -c "cd '${ROOT}/server' && npm audit --omit=dev --audit-level=high"
step "upgrade from the previous deployed schema" \
                              bash -c "cd '${ROOT}' && ./scripts/verify-upgrade.sh"

step "migration ledger and foreign-key indexes" \
                              bash -c "cd '${ROOT}' && ./scripts/check-db-hygiene.sh linkerp_test"

step "backup restores into a separate database" \
                              bash -c "cd '${ROOT}' && POSTGRES_DB=linkerp_test ./scripts/verify-backup-restore.sh"

# ------------------------------------------------------------------- web --

step "web: install"    bash -c "cd '${ROOT}/link-erp' && npm ci --silent"
step "web: typecheck"  bash -c "cd '${ROOT}/link-erp' && npm run typecheck"
step "web: tests"      bash -c "cd '${ROOT}/link-erp' && npm test"
step "web: build"      bash -c "cd '${ROOT}/link-erp' && npm run build"
step "web: production dependency audit" \
                        bash -c "cd '${ROOT}/link-erp' && npm audit --omit=dev --audit-level=high"
step "browser: desktop, mobile, accessibility, every module" \
                        bash -c "cd '${ROOT}' && ./scripts/test-browser-local.sh"

# ------------------------------------------------------------ containers --

if docker info > /dev/null 2>&1; then
  step "api image builds"  docker build -q -t link-erp-api "${ROOT}/server"
  step "web image builds"  docker build -q -t link-erp-web "${ROOT}/link-erp"
else
  printf '\n\033[33m==> docker is not running; skipping the image builds\033[0m\n'
fi

# ---------------------------------------------------------------- volume --

if [ "${WITH_LOAD:-}" = "true" ]; then
  step "queries stay fast at a year's volume" \
    bash -c "cd '${ROOT}/link-erp/db' && ./load/run.sh"
fi

printf '\n\033[1m%d passed, %d failed\033[0m\n' "${PASS}" "${FAIL}"
[ "${FAIL}" -eq 0 ]
