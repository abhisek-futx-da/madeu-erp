-- TDS sections and the financial year for the demo tenant.
--
-- RATES AND THRESHOLDS ARE CONFIGURATION, not code. The values below were read
-- from the sources in docs/tds-rates.md on 2026-08-21; a mill's CA should
-- confirm them against the current year before going live.

begin;
set local app.tenant_id = '11111111-1111-1111-1111-111111111111';

insert into tax_deduction_section
  (tenant_id, code, kind, description, rate, rate_no_pan, threshold, basis, applies_to) values
  ('11111111-1111-1111-1111-111111111111','194C-IND','tds',
   'Contractor / jobwork payment to an individual or HUF', 1.0, 20.0, 100000,
   'full_once_crossed','purchase'),
  ('11111111-1111-1111-1111-111111111111','194C-OTH','tds',
   'Contractor / jobwork payment to a firm, LLP or company', 2.0, 20.0, 100000,
   'full_once_crossed','purchase'),
  ('11111111-1111-1111-1111-111111111111','194Q','tds',
   'Purchase of goods beyond the annual threshold', 0.1, 5.0, 5000000,
   'excess_over_threshold','purchase')
on conflict (tenant_id, code) do nothing;

-- Process houses do jobwork, so 194C applies to what we pay them.
update ledger_account set tds_section = '194C-OTH'
 where tenant_id = '11111111-1111-1111-1111-111111111111'
   and code in ('201','202')
   and tds_section is distinct from '194C-OTH';

insert into financial_year (tenant_id, label, starts_on, ends_on, status) values
  ('11111111-1111-1111-1111-111111111111','2025-26','2025-04-01','2026-03-31','closed'),
  ('11111111-1111-1111-1111-111111111111','2026-27','2026-04-01','2027-03-31','open')
on conflict (tenant_id, label) do nothing;

insert into ledger_account (id, tenant_id, code, name, control_account_id, gst_reg_type) values
  ('33333333-0000-0000-0000-000000000940','11111111-1111-1111-1111-111111111111','940',
   'TDS Payable','22222222-0000-0000-0000-000000000081','unregistered')
on conflict (tenant_id, code) do nothing;

insert into document_series (tenant_id, doc_type, fy_label, prefix, next_number) values
  ('11111111-1111-1111-1111-111111111111','voucher_journal','2026-27','JV-',1),
  ('11111111-1111-1111-1111-111111111111','sales_order','2026-27','SO/26-27/',1)
on conflict (tenant_id, doc_type, fy_label) do nothing;

commit;
