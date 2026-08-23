#!/usr/bin/env bash
# Run every minute from an independent machine. Success is quiet; failure is
# sent to the configured alert receiver and returns non-zero to the scheduler.
set -euo pipefail

: "${HEALTHCHECK_URL:?set the public HTTPS /health URL}"
: "${ALERT_WEBHOOK_URL:?set an HTTPS receiver accepting a JSON text field}"

BODY="$(curl -fsS --max-time 10 --retry 1 "${HEALTHCHECK_URL}" 2>/dev/null || true)"
if printf '%s' "${BODY}" | grep -Eq '"ok"[[:space:]]*:[[:space:]]*true'; then
  exit 0
fi

curl -fsS --max-time 10 -H 'content-type: application/json' \
  --data '{"text":"CRITICAL: Link ERP health check failed. Operators must stop posting until service and database health are confirmed."}' \
  "${ALERT_WEBHOOK_URL}" >/dev/null || true
echo "Link ERP health check failed: ${HEALTHCHECK_URL}" >&2
exit 1
