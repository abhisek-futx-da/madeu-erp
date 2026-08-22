#!/usr/bin/env bash
#
# Builds a year of a working mill and asserts the queries a clerk and an owner
# run all day stay fast at that volume.
#
# Every performance claim before this rested on a demo database of two thousand
# pieces, which a Bhiwandi trader moves in a fortnight. This builds 1.5 lakh
# pieces with their movements, invoices and vouchers, then fails if anything
# crosses a budget a person would notice.
#
#   PGHOST=... PGPORT=... PGUSER=postgres ./load/run.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DB="${LOAD_DB:-linkerp_load}"
: "${PGHOST:?set PGHOST}"; : "${PGPORT:?set PGPORT}"
export PGUSER="${PGUSER:-postgres}"

if [ "${SKIP_BUILD:-}" != "true" ]; then
  echo "==> building ${DB} at volume (this takes a minute)"
  "${HERE}/../rebuild.sh" "${DB}" > /tmp/load-build.log 2>&1 || {
    tail -20 /tmp/load-build.log; exit 1; }
  psql -q -v ON_ERROR_STOP=1 -d "${DB}" -f "${HERE}/generate.sql" 2>&1 | grep -E '^ *[0-9]+ \|' || true
fi

# Budgets in milliseconds. A clerk scanning a barcode waits on the first two
# all day, so they are tight; a statement is opened a few times a day.
declare -a CHECKS=(
  "barcode lookup|50|select id from piece where barcode = 'LOAD98765'"
  "piece history|100|select count(*) from v_barcode_history where barcode = 'LOAD98765'"
  "invoice list page 1|150|select id from sales_invoice order by invoice_date desc, created_at desc limit 50"
  "invoice list page 40|250|select id from sales_invoice order by invoice_date desc, created_at desc limit 50 offset 2000"
  "pieces by status|300|select count(*) from piece where status = 'grey_in_stock'"
  "outstanding receivables|400|select count(*) from v_outstanding_sales"
  "trial balance|500|select count(*) from v_trial_balance"
  "profit and loss|600|select count(*) from report_profit_loss('2026-04-01','2027-03-31')"
  "balance sheet|800|select count(*) from report_balance_sheet('2027-03-31')"
  "stock valuation|800|select count(*) from v_stock_valuation"
  "GSTR-1 B2B|800|select count(*) from v_gstr1_b2b"
  "dashboard|1500|select * from report_dashboard()"
  "spine drift check|2000|select count(*) from v_piece_drift"
)

echo ""
printf '%-28s %10s %10s   %s\n' "query" "took" "budget" "verdict"
printf '%-28s %10s %10s   %s\n' "----------------------------" "----------" "----------" "-------"

FAILED=0
for check in "${CHECKS[@]}"; do
  IFS='|' read -r name budget sql <<< "${check}"
  # One warm-up then three timed runs, reporting the median. A real server has
  # been up for a week; this one has a 465,000-row table it wrote seconds ago
  # and not yet read, and a single cold read of it was failing the build at
  # random. The median still moves if a query genuinely gets slower.
  times=""
  for run in 0 1 2 3; do
    ms="$(PGUSER=link_erp_app psql -tAq -d "${DB}" \
      -c "set app.tenant_id='11111111-1111-1111-1111-111111111111';" \
      -c "\timing on" -c "${sql}" 2>&1 | grep -oE 'Time: [0-9.]+' | tail -1 | cut -d' ' -f2)"
    [ "${run}" -gt 0 ] && times="${times}${ms:-99999}"$'\n'
  done
  ms="$(printf '%s' "${times}" | sort -n | sed -n '2p')"
  ms="${ms:-99999}"
  if awk "BEGIN{exit !(${ms} > ${budget})}"; then
    printf '%-28s %9sms %9sms   OVER BUDGET\n' "${name}" "${ms}" "${budget}"
    FAILED=$((FAILED + 1))
  else
    printf '%-28s %9sms %9sms   ok\n' "${name}" "${ms}" "${budget}"
  fi
done

echo ""
PGUSER=link_erp_app psql -tAq -d "${DB}" \
  -c "set app.tenant_id='11111111-1111-1111-1111-111111111111';" \
  -c "select 'volume: ' || (select count(*) from piece) || ' pieces, '
             || (select count(*) from piece_movement) || ' movements, '
             || (select count(*) from sales_invoice) || ' invoices, '
             || pg_size_pretty(pg_database_size(current_database()))"

if [ "${FAILED}" -ne 0 ]; then
  echo "${FAILED} queries over budget" >&2
  exit 1
fi
echo "every query within budget at a year's volume"
