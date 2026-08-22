-- Ledgers a physical count posts to, and the rule that makes one approvable.
--
-- A verification surplus and a verification shortage are separate P&L lines on
-- purpose: netting them hides the one figure an owner actually wants, which is
-- how much stock went missing this quarter.

begin;
set local app.tenant_id = '11111111-1111-1111-1111-111111111111';

insert into control_account (id, tenant_id, code, name, sub_control, nature) values
  ('22222222-0000-0000-0000-000000000095','11111111-1111-1111-1111-111111111111','95',
   'Stock Loss On Verification','Indirect Expenses','expense'),
  ('22222222-0000-0000-0000-000000000096','11111111-1111-1111-1111-111111111111','96',
   'Stock Gain On Verification','Indirect Income','income')
on conflict (tenant_id, code) do nothing;

insert into ledger_account (id, tenant_id, code, name, control_account_id, gst_reg_type) values
  ('33333333-0000-0000-0000-000000000963','11111111-1111-1111-1111-111111111111','963',
   'Stock Loss On Verification','22222222-0000-0000-0000-000000000095','unregistered'),
  ('33333333-0000-0000-0000-000000000964','11111111-1111-1111-1111-111111111111','964',
   'Stock Gain On Verification','22222222-0000-0000-0000-000000000096','unregistered')
on conflict (tenant_id, code) do nothing;

update ledger_account set posting_role = v.role::posting_role
  from (values ('963','stock_loss'), ('964','stock_gain')) as v(code, role)
 where ledger_account.tenant_id = '11111111-1111-1111-1111-111111111111'
   and ledger_account.code = v.code
   and ledger_account.posting_role is distinct from v.role::posting_role;

-- Zero, because the control is the second signature itself, not its value.
insert into approval_rule (tenant_id, doc_type, min_amount, approver_role) values
  ('11111111-1111-1111-1111-111111111111','stock_count',0,'owner'),
  ('11111111-1111-1111-1111-111111111111','grey_return',0,'accounts'),
  ('11111111-1111-1111-1111-111111111111','dyeing_return',0,'accounts'),
  ('11111111-1111-1111-1111-111111111111','customer_return',0,'accounts')
on conflict (tenant_id, doc_type) do nothing;

insert into document_series (tenant_id, doc_type, fy_label, prefix, next_number) values
  ('11111111-1111-1111-1111-111111111111','stock_count','2026-27','SC/26-27/',1)
on conflict (tenant_id, doc_type, fy_label) do nothing;

-- Give the demo stock a shelf, so "wrong rack" means something on day one.
update piece set rack_code = case when status = 'grey_in_stock' then 'A1' else 'B1' end
 where tenant_id = '11111111-1111-1111-1111-111111111111'
   and rack_code is null
   and status in ('grey_in_stock','received_finish','cut_packed');

commit;
