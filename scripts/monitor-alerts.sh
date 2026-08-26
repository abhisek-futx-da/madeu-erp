#!/usr/bin/env bash
#
# Business alerts, run every fifteen minutes from the same machine that runs
# monitor-health.sh.
#
# `monitor-health.sh` answers "is it up". This answers the question that
# actually loses a mill money: is anything piling up that a person was supposed
# to deal with. An ERP serving every request in nine milliseconds while forty
# thaans have sat unacknowledged at a dyeing house for three weeks is not
# healthy, and no uptime check will ever say so.
#
#   METRICS_URL=https://erp.example.com/metrics \
#   METRICS_TOKEN=... ALERT_WEBHOOK_URL=... ./scripts/monitor-alerts.sh
#
# Thresholds are environment variables because the right number is a property
# of the mill, not of the software. Start with these and tune them in the first
# fortnight of a pilot.
set -euo pipefail

: "${METRICS_URL:?set the /metrics URL}"
: "${METRICS_TOKEN:?set the monitoring token}"
: "${ALERT_WEBHOOK_URL:?set an HTTPS receiver accepting a JSON text field}"

MAX_APPROVALS="${MAX_APPROVALS:-25}"
MAX_DECLARATIONS="${MAX_DECLARATIONS:-10}"
MAX_UNACKNOWLEDGED="${MAX_UNACKNOWLEDGED:-15}"
MAX_JOBWORK_OVER_A_YEAR="${MAX_JOBWORK_OVER_A_YEAR:-0}"
MAX_EINVOICE_BACKLOG="${MAX_EINVOICE_BACKLOG:-50}"
MAX_DB_WAITING="${MAX_DB_WAITING:-5}"

BODY="$(curl -fsS --max-time 15 -H "authorization: Bearer ${METRICS_TOKEN}" "${METRICS_URL}" || true)"
if [ -z "${BODY}" ]; then
  echo "could not scrape ${METRICS_URL}" >&2
  exit 1   # monitor-health.sh owns the "it is down" alert; do not duplicate it.
fi

gauge() {
  printf '%s\n' "${BODY}" \
    | awk -v k="kind=\"$1\"" '$0 ~ /^link_erp_backlog\{/ && index($0, k) { print $NF; exit }'
}
plain() {
  printf '%s\n' "${BODY}" | awk -v n="$1" '$1 == n { print $NF; exit }'
}

PROBLEMS=()
check() {
  local label="$1" value="$2" limit="$3"
  [ -n "${value}" ] || return 0
  # Integer comparison only; a non-numeric scrape is a scrape problem, not an alert.
  case "${value}" in (*[!0-9]*) return 0;; esac
  if [ "${value}" -gt "${limit}" ]; then
    PROBLEMS+=("${label}: ${value} (limit ${limit})")
  fi
}

if [ "$(printf '%s\n' "${BODY}" | awk '$1 == "link_erp_database_reachable" { print $NF; exit }')" = "0" ]; then
  PROBLEMS+=("the API is up but cannot reach the database")
fi

check "approvals waiting on a second signature" "$(gauge approvals_pending)"        "${MAX_APPROVALS}"
check "process-house declarations nobody has answered" "$(gauge declarations_unanswered)" "${MAX_DECLARATIONS}"
check "job-work challans the process house has not acknowledged" "$(gauge challans_unacknowledged)" "${MAX_UNACKNOWLEDGED}"
check "thaans out at a process house beyond twelve months (s.143(1))" "$(gauge jobwork_over_a_year)" "${MAX_JOBWORK_OVER_A_YEAR}"
check "invoices with no IRN" "$(gauge einvoice_backlog)"                            "${MAX_EINVOICE_BACKLOG}"
check "database connections waiting for a free client" "$(plain link_erp_db_pool 2>/dev/null || true)" "${MAX_DB_WAITING}"

if [ "${#PROBLEMS[@]}" -eq 0 ]; then
  exit 0
fi

TEXT="Link ERP backlog alert:"
for problem in "${PROBLEMS[@]}"; do
  TEXT="${TEXT}
- ${problem}"
done
TEXT="${TEXT}

Runbook: docs/INCIDENT_RUNBOOK.md"

# jq is not assumed on a monitoring box; escape by hand for the JSON body.
ESCAPED="$(printf '%s' "${TEXT}" | sed 's/\\/\\\\/g; s/"/\\"/g' | awk 'BEGIN{ORS="\\n"} {print}')"
curl -fsS --max-time 15 -H 'content-type: application/json' \
  --data "{\"text\":\"${ESCAPED}\"}" "${ALERT_WEBHOOK_URL}" > /dev/null || true

printf '%s\n' "${TEXT}" >&2
exit 1
