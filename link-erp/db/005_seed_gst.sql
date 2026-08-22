-- Tax ledgers and posting roles for the demo tenant. Idempotent.

begin;

set local app.tenant_id = '11111111-1111-1111-1111-111111111111';

insert into control_account (id, tenant_id, code, name, sub_control, nature) values
  ('22222222-0000-0000-0000-000000000081','11111111-1111-1111-1111-111111111111','81','Output GST','Duties & Taxes','duties_and_taxes'),
  ('22222222-0000-0000-0000-000000000082','11111111-1111-1111-1111-111111111111','82','Input GST','Duties & Taxes','duties_and_taxes'),
  ('22222222-0000-0000-0000-000000000095','11111111-1111-1111-1111-111111111111','95','Rounding','Indirect Expenses','expense')
on conflict (tenant_id, code) do nothing;

insert into ledger_account (id, tenant_id, code, name, control_account_id, gst_reg_type) values
  ('33333333-0000-0000-0000-000000000910','11111111-1111-1111-1111-111111111111','910','Output CGST','22222222-0000-0000-0000-000000000081','unregistered'),
  ('33333333-0000-0000-0000-000000000911','11111111-1111-1111-1111-111111111111','911','Output SGST','22222222-0000-0000-0000-000000000081','unregistered'),
  ('33333333-0000-0000-0000-000000000912','11111111-1111-1111-1111-111111111111','912','Output IGST','22222222-0000-0000-0000-000000000081','unregistered'),
  ('33333333-0000-0000-0000-000000000920','11111111-1111-1111-1111-111111111111','920','Input CGST','22222222-0000-0000-0000-000000000082','unregistered'),
  ('33333333-0000-0000-0000-000000000921','11111111-1111-1111-1111-111111111111','921','Input SGST','22222222-0000-0000-0000-000000000082','unregistered'),
  ('33333333-0000-0000-0000-000000000922','11111111-1111-1111-1111-111111111111','922','Input IGST','22222222-0000-0000-0000-000000000082','unregistered'),
  ('33333333-0000-0000-0000-000000000930','11111111-1111-1111-1111-111111111111','930','Rounding Off','22222222-0000-0000-0000-000000000095','unregistered'),
  ('33333333-0000-0000-0000-000000000931','11111111-1111-1111-1111-111111111111','931','RCM Liability','22222222-0000-0000-0000-000000000081','unregistered'),
  ('33333333-0000-0000-0000-000000000903','11111111-1111-1111-1111-111111111111','903','Dyeing & Processing Charges','22222222-0000-0000-0000-000000000090','unregistered')
on conflict (tenant_id, code) do nothing;

-- Bind each posting role to exactly one ledger.
update ledger_account set posting_role = v.role::posting_role
  from (values
    ('900','purchase_grey'), ('903','purchase_jobwork'), ('901','sales_finish'),
    ('910','cgst_output'), ('911','sgst_output'), ('912','igst_output'),
    ('920','cgst_input'),  ('921','sgst_input'),  ('922','igst_input'),
    ('930','round_off'),   ('931','rcm_liability')
  ) as v(code, role)
 where ledger_account.tenant_id = '11111111-1111-1111-1111-111111111111'
   and ledger_account.code = v.code
   and ledger_account.posting_role is distinct from v.role::posting_role;

insert into document_series (tenant_id, doc_type, fy_label, prefix, next_number) values
  ('11111111-1111-1111-1111-111111111111','sales_invoice','2026-27','NKT/26-27/',1)
on conflict (tenant_id, doc_type, fy_label) do nothing;

commit;
