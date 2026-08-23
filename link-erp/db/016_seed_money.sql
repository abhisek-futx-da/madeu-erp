-- Inventory, COGS, cash/bank and discount ledgers, plus the extra masters.

begin;
set local app.tenant_id = '11111111-1111-1111-1111-111111111111';

insert into control_account (id, tenant_id, code, name, sub_control, nature) values
  ('22222222-0000-0000-0000-000000000015','11111111-1111-1111-1111-111111111111','15','Current Assets - Stock','Inventory','current_asset'),
  ('22222222-0000-0000-0000-000000000016','11111111-1111-1111-1111-111111111111','16','Bank Accounts','Bank','bank'),
  ('22222222-0000-0000-0000-000000000017','11111111-1111-1111-1111-111111111111','17','Cash In Hand','Cash','cash'),
  ('22222222-0000-0000-0000-000000000092','11111111-1111-1111-1111-111111111111','92','Cost Of Goods Sold','Direct Expenses','expense'),
  ('22222222-0000-0000-0000-000000000093','11111111-1111-1111-1111-111111111111','93','Discounts Allowed','Indirect Expenses','expense'),
  ('22222222-0000-0000-0000-000000000094','11111111-1111-1111-1111-111111111111','94','Discounts Received','Indirect Income','income'),
  ('22222222-0000-0000-0000-000000000098','11111111-1111-1111-1111-111111111111','98','Brokerage Expense','Indirect Expenses','expense')
on conflict (tenant_id, code) do nothing;

insert into ledger_account (id, tenant_id, code, name, control_account_id, gst_reg_type) values
  ('33333333-0000-0000-0000-000000000960','11111111-1111-1111-1111-111111111111','960','Grey Stock','22222222-0000-0000-0000-000000000015','unregistered'),
  ('33333333-0000-0000-0000-000000000961','11111111-1111-1111-1111-111111111111','961','Finish Stock','22222222-0000-0000-0000-000000000015','unregistered'),
  ('33333333-0000-0000-0000-000000000962','11111111-1111-1111-1111-111111111111','962','Cost Of Goods Sold','22222222-0000-0000-0000-000000000092','unregistered'),
  ('33333333-0000-0000-0000-000000000970','11111111-1111-1111-1111-111111111111','970','Cash In Hand','22222222-0000-0000-0000-000000000017','unregistered'),
  ('33333333-0000-0000-0000-000000000971','11111111-1111-1111-1111-111111111111','971','HDFC Bank - Current','22222222-0000-0000-0000-000000000016','unregistered'),
  ('33333333-0000-0000-0000-000000000980','11111111-1111-1111-1111-111111111111','980','Discount Allowed','22222222-0000-0000-0000-000000000093','unregistered'),
  ('33333333-0000-0000-0000-000000000981','11111111-1111-1111-1111-111111111111','981','Discount Received','22222222-0000-0000-0000-000000000094','unregistered'),
  ('33333333-0000-0000-0000-000000000982','11111111-1111-1111-1111-111111111111','982','Brokerage Expense','22222222-0000-0000-0000-000000000098','unregistered')
on conflict (tenant_id, code) do nothing;

update ledger_account set posting_role = v.role::posting_role
  from (values
    ('960','inventory_grey'), ('961','inventory_finish'), ('962','cogs'),
    ('970','cash'), ('971','bank'),
    ('980','discount_allowed'), ('981','discount_received')
  ) as v(code, role)
 where ledger_account.tenant_id = '11111111-1111-1111-1111-111111111111'
   and ledger_account.code = v.code
   and ledger_account.posting_role is distinct from v.role::posting_role;

-- In an upgrade rehearsal this seed is applied before migration 049 adds the
-- enum value. On a fresh build 049 already exists, so bind it here; on upgrade
-- 049 binds the same neutral ledger after adding the value.
do $$
begin
  if exists (
    select 1 from pg_enum e join pg_type t on t.oid=e.enumtypid
     where t.typname='posting_role' and e.enumlabel='brokerage_expense'
  ) then
    update ledger_account set posting_role='brokerage_expense'
     where tenant_id='11111111-1111-1111-1111-111111111111' and code='982'
       and posting_role is null;
  end if;
end $$;

insert into bank_account (tenant_id, ledger_id, bank_name, account_no, ifsc, branch, is_default) values
  ('11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000971',
   'HDFC Bank','50200012345678','HDFC0000123','Bhiwandi', true)
on conflict (tenant_id, account_no) do nothing;

insert into unit_master (tenant_id, code, name, uqc) values
  ('11111111-1111-1111-1111-111111111111','MTR','Meters','MTR'),
  ('11111111-1111-1111-1111-111111111111','PCS','Pieces','PCS'),
  ('11111111-1111-1111-1111-111111111111','KGS','Kilograms','KGS'),
  ('11111111-1111-1111-1111-111111111111','YDS','Yards','YDS')
on conflict (tenant_id, code) do nothing;

insert into width_master (tenant_id, code, cms, inches) values
  ('11111111-1111-1111-1111-111111111111','89',89,35),
  ('11111111-1111-1111-1111-111111111111','147',147,58),
  ('11111111-1111-1111-1111-111111111111','152',152,60)
on conflict (tenant_id, code) do nothing;

insert into rack_master (tenant_id, code, name, location) values
  ('11111111-1111-1111-1111-111111111111','A1','Rack A1','Godown 1 - Grey'),
  ('11111111-1111-1111-1111-111111111111','B1','Rack B1','Godown 2 - Finish')
on conflict (tenant_id, code) do nothing;

insert into rate_contract (tenant_id, party_id, quality_id, kind, rate, valid_from) values
  ('11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000105',
   '44444444-0000-0000-0000-000000000001','purchase',30.50,'2026-04-01'),
  ('11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000202',
   null,'jobwork',18.00,'2026-04-01'),
  ('11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000701',
   '44444444-0000-0000-0000-000000000001','sales',72.00,'2026-04-01')
on conflict do nothing;

-- Give the demo customer a credit limit so the control is exercisable.
update ledger_account set credit_limit = 500000
 where tenant_id = '11111111-1111-1111-1111-111111111111' and code = '701'
   and credit_limit = 0;

insert into document_series (tenant_id, doc_type, fy_label, prefix, next_number) values
  ('11111111-1111-1111-1111-111111111111','receipt_voucher','2026-27','RV/26-27/',1),
  ('11111111-1111-1111-1111-111111111111','payment_voucher','2026-27','PV/26-27/',1),
  ('11111111-1111-1111-1111-111111111111','voucher_receipt','2026-27','RCT-',1),
  ('11111111-1111-1111-1111-111111111111','voucher_payment','2026-27','PMT-',1)
on conflict (tenant_id, doc_type, fy_label) do nothing;

commit;
