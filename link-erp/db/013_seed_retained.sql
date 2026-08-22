begin;
set local app.tenant_id = '11111111-1111-1111-1111-111111111111';

insert into control_account (id, tenant_id, code, name, sub_control, nature) values
  ('22222222-0000-0000-0000-000000000099','11111111-1111-1111-1111-111111111111','99',
   'Capital & Reserves','Capital Account','capital')
on conflict (tenant_id, code) do nothing;

insert into ledger_account (id, tenant_id, code, name, control_account_id, gst_reg_type) values
  ('33333333-0000-0000-0000-000000000950','11111111-1111-1111-1111-111111111111','950',
   'Retained Earnings','22222222-0000-0000-0000-000000000099','unregistered')
on conflict (tenant_id, code) do nothing;

update ledger_account set posting_role = 'retained_earnings'
 where tenant_id = '11111111-1111-1111-1111-111111111111' and code = '950'
   and posting_role is distinct from 'retained_earnings';

commit;
