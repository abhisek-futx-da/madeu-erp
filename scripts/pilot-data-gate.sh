#!/usr/bin/env bash
# Read-only gate over the real tenant after owner/CA setup and before the first
# live posting. It cannot certify tax treatment; it prevents an obviously
# incomplete or demo-contaminated company from entering a pilot.
set -euo pipefail

: "${PILOT_TENANT_ID:?set the real tenant UUID}"
[[ "${PILOT_TENANT_ID}" =~ ^[0-9a-fA-F-]{36}$ ]] || { echo 'PILOT_TENANT_ID is not a UUID' >&2; exit 2; }
export PGUSER="${PGUSER:-postgres}"
DB="${POSTGRES_DB:-linkerp}"
FAIL=0

query() {
  psql -X -qAt -v ON_ERROR_STOP=1 -v tenant_id="${PILOT_TENANT_ID}" -d "${DB}" <<SQL | tr -d '\r'
$1
SQL
}
ok() { printf '  ok    %s\n' "$1"; }
bad() { printf '  FAIL  %s\n' "$1" >&2; FAIL=1; }
equals() {
  local label="$1" sql="$2" expected="$3" actual
  actual="$(query "${sql}")"
  [ "${actual}" = "${expected}" ] && ok "${label}" || bad "${label} (got ${actual:-empty}, expected ${expected})"
}
at_least() {
  local label="$1" sql="$2" minimum="$3" actual
  actual="$(query "${sql}")"
  [[ "${actual}" =~ ^[0-9]+$ ]] && [ "${actual}" -ge "${minimum}" ] \
    && ok "${label}" || bad "${label} (got ${actual:-empty}, need at least ${minimum})"
}

printf 'Link ERP real-tenant pilot data gate\n'
equals 'tenant exists exactly once' \
  "select count(*) from tenant where id = :'tenant_id'::uuid" 1
equals 'legal entity is not demo/test data' \
  "select count(*) from tenant where id = :'tenant_id'::uuid and (legal_name ilike '%neelkamal%' or gstin like '27ANBPC3604Q1Z0')" 0
equals 'no .test identity belongs to the company' \
  "select count(*) from membership m join app_user u on u.id=m.user_id where m.tenant_id=:'tenant_id'::uuid and u.email like '%.test'" 0
at_least 'one active owner is named' \
  "select count(*) from membership where tenant_id=:'tenant_id'::uuid and role='owner' and is_active" 1
equals 'no live accounting document has started before cutover approval' \
  "select count(*) from voucher where tenant_id=:'tenant_id'::uuid and is_posted" 0
at_least 'one independent active accounts checker is named' \
  "select count(*) from membership where tenant_id=:'tenant_id'::uuid and role='accounts' and is_active" 1
equals 'every active owner/accounts user has enabled MFA' \
  "select count(*) from membership m left join user_mfa f on f.user_id=m.user_id and f.enabled_at is not null where m.tenant_id=:'tenant_id'::uuid and m.is_active and m.role in ('owner','accounts') and f.user_id is null" 0
equals 'every active owner/accounts user changed their own temporary password' \
  "select count(*) from membership m where m.tenant_id=:'tenant_id'::uuid and m.is_active and m.role in ('owner','accounts') and not exists (select 1 from access_audit a where a.tenant_id=m.tenant_id and a.target_user_id=m.user_id and a.actor_id=m.user_id and a.event='password_changed')" 0
equals 'exactly one active default business location exists' \
  "select count(*) from business_location where tenant_id=:'tenant_id'::uuid and is_default and is_active" 1
equals 'every active user has a live permission profile and business location' \
  "select count(*) from membership m left join permission_profile p on p.id=m.permission_profile_id and p.tenant_id=m.tenant_id and p.is_active left join business_location l on l.id=m.active_location_id and l.tenant_id=m.tenant_id and l.is_active where m.tenant_id=:'tenant_id'::uuid and m.is_active and (p.id is null or l.id is null or p.base_role<>m.role)" 0
equals 'exactly one financial year is open' \
  "select count(*) from financial_year where tenant_id=:'tenant_id'::uuid and status='open'" 1
equals 'CA/owner explicitly saved opening books, including a zero opening' \
  "select case when exists (select 1 from opening_balance_revision r join financial_year fy on fy.tenant_id=r.tenant_id and fy.label=r.fy_label where r.tenant_id=:'tenant_id'::uuid and fy.status='open') then 1 else 0 end" 1
equals 'opening debit equals opening credit' \
  "select case when abs(coalesce(sum(ob.debit-ob.credit),0)) < 0.005 then 1 else 0 end from opening_balance ob join financial_year fy on fy.tenant_id=ob.tenant_id and fy.label=ob.fy_label where ob.tenant_id=:'tenant_id'::uuid and fy.status='open'" 1
equals 'physical opening stock value matches inventory opening ledgers' \
  "select case when abs((select coalesce(sum(p.grey_cost+p.jobwork_cost+p.other_cost),0) from piece p where p.tenant_id=:'tenant_id'::uuid and p.status in ('grey_in_stock','received_finish','cut_packed','issued_to_dyeing','reprocess_at_process_house'))-(select coalesce(sum(ob.debit-ob.credit),0) from opening_balance ob join ledger_account l on l.id=ob.ledger_id join financial_year fy on fy.tenant_id=ob.tenant_id and fy.label=ob.fy_label where ob.tenant_id=:'tenant_id'::uuid and fy.status='open' and l.posting_role in ('inventory_grey','inventory_finish'))) < 0.005 then 1 else 0 end" 1
equals 'bill-wise opening receivables match debtor opening balances' \
  "select case when abs((select coalesce(sum(o.original_amount),0) from opening_outstanding o join financial_year fy on fy.tenant_id=o.tenant_id and fy.label=o.fy_label where o.tenant_id=:'tenant_id'::uuid and fy.status='open' and o.kind='receivable' and o.status='open')-(select coalesce(sum(ob.debit-ob.credit),0) from opening_balance ob join ledger_account l on l.id=ob.ledger_id join control_account c on c.id=l.control_account_id join financial_year fy on fy.tenant_id=ob.tenant_id and fy.label=ob.fy_label where ob.tenant_id=:'tenant_id'::uuid and fy.status='open' and c.nature='sundry_debtor_finish')) < 0.005 then 1 else 0 end" 1
equals 'bill-wise opening payables match creditor opening balances' \
  "select case when abs((select coalesce(sum(o.original_amount),0) from opening_outstanding o join financial_year fy on fy.tenant_id=o.tenant_id and fy.label=o.fy_label where o.tenant_id=:'tenant_id'::uuid and fy.status='open' and o.kind='payable' and o.status='open')-(select coalesce(sum(ob.credit-ob.debit),0) from opening_balance ob join ledger_account l on l.id=ob.ledger_id join control_account c on c.id=l.control_account_id join financial_year fy on fy.tenant_id=ob.tenant_id and fy.label=ob.fy_label where ob.tenant_id=:'tenant_id'::uuid and fy.status='open' and c.nature::text like 'sundry_creditor_%')) < 0.005 then 1 else 0 end" 1
equals 'no deprecated ledger-level opening remains' \
  "select count(*) from ledger_account where tenant_id=:'tenant_id'::uuid and abs(opening_balance) >= 0.005" 0
equals 'exactly one default bank account is configured' \
  "select count(*) from bank_account where tenant_id=:'tenant_id'::uuid and is_default" 1
at_least 'at least one CA-approved HSN/SAC exists' \
  "select count(*) from hsn_code where tenant_id=:'tenant_id'::uuid" 1
at_least 'at least one live textile quality exists' \
  "select count(*) from quality where tenant_id=:'tenant_id'::uuid and is_active" 1
at_least 'at least one physical rack/location exists' \
  "select count(*) from rack_master where tenant_id=:'tenant_id'::uuid" 1
equals 'every rack belongs to an active business location' \
  "select count(*) from rack_master r left join business_location l on l.id=r.business_location_id and l.tenant_id=r.tenant_id and l.is_active where r.tenant_id=:'tenant_id'::uuid and l.id is null" 0
equals 'all nine financial/stock exception classes have active owner approval' \
  "select count(distinct doc_type) from approval_rule where tenant_id=:'tenant_id'::uuid and is_active and approver_role='owner' and doc_type in ('sales_invoice','purchase_invoice','payment','stock_count','customer_return','grey_return','dyeing_return','write_off','dyeing_reprocess_receipt')" 9
at_least 'document numbering exists for the open year' \
  "select count(*) from document_series ds join financial_year fy on fy.tenant_id=ds.tenant_id and fy.label=ds.fy_label where ds.tenant_id=:'tenant_id'::uuid and fy.status='open'" 15
equals 'core company policies are explicitly configured' \
  "select count(*) from tenant_setting where tenant_id=:'tenant_id'::uuid and key in ('invoice.rounding','credit.enforce_limit')" 2

if [ "${FAIL}" -ne 0 ]; then
  echo 'Pilot data gate failed. Do not enter live documents.' >&2
  exit 1
fi
echo 'Pilot data gate passed. CA, GSP/IRP, and controlled-mill acceptance are still separate gates.'
