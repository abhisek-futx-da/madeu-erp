-- Default policies for the demo tenant. Idempotent.

begin;
set local app.tenant_id = '11111111-1111-1111-1111-111111111111';

insert into tenant_setting (tenant_id, key, value) values
  ('11111111-1111-1111-1111-111111111111','invoice.rounding','"nearest_rupee"'),
  ('11111111-1111-1111-1111-111111111111','credit.enforce_limit','true')
on conflict (tenant_id, key) do nothing;

-- Tenant default, then a tighter rule for the process house we watch closely.
insert into shrinkage_policy (tenant_id, quality_id, process_house_id, warn_pct, max_pct, gain_pct) values
  ('11111111-1111-1111-1111-111111111111', null, null, 8, 12, 1),
  ('11111111-1111-1111-1111-111111111111', null, '33333333-0000-0000-0000-000000000202', 6, 9, 1)
on conflict do nothing;

insert into brokerage_rule (tenant_id, broker_id, party_id, doc_type, basis, rate) values
  ('11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000801',null,'sales_invoice','percent_of_value',0.5)
on conflict do nothing;

insert into document_series (tenant_id, doc_type, fy_label, prefix, next_number) values
  ('11111111-1111-1111-1111-111111111111','purchase_invoice','2026-27','PB/26-27/',1),
  ('11111111-1111-1111-1111-111111111111','credit_note','2026-27','CN/26-27/',1),
  ('11111111-1111-1111-1111-111111111111','debit_note','2026-27','DN/26-27/',1),
  ('11111111-1111-1111-1111-111111111111','voucher_credit_note','2026-27','CV-',1),
  ('11111111-1111-1111-1111-111111111111','voucher_debit_note','2026-27','DV-',1)
on conflict (tenant_id, doc_type, fy_label) do nothing;

commit;
