-- Seed-only reconciliation for demo tenants created after the numbered
-- migrations. Existing production tenants are handled by migration 052 and
-- tenants created through the API are handled by the bootstrap transaction.

begin;

insert into control_account (tenant_id, code, name, sub_control, nature)
select id, '18', 'Current Tax Assets', 'Current Assets', 'current_asset'
from tenant
on conflict (tenant_id, code) do nothing;

insert into ledger_account
  (tenant_id, code, name, control_account_id, gst_reg_type)
select t.id, x.code, x.name, c.id, 'unregistered'
from tenant t
join (values
  ('984', 'Quality / Shade Deductions', '93'),
  ('985', 'Rate Difference', '93'),
  ('986', 'Shortage Claims', '93'),
  ('987', 'Brokerage Accrued — Not Yet Payable', '10'),
  ('988', 'TDS Receivable', '18'),
  ('940', 'TDS Payable', '80')
) as x(code, name, control_code) on true
join control_account c
  on c.tenant_id = t.id
 and c.code = x.control_code
on conflict (tenant_id, code) do nothing;

update ledger_account l
set posting_role = x.role::posting_role
from (values
  ('984', 'quality_deduction'),
  ('985', 'rate_difference'),
  ('986', 'shortage_claim'),
  ('987', 'brokerage_accrued'),
  ('988', 'tds_receivable'),
  ('940', 'tds_payable')
) as x(code, role)
where l.code = x.code
  and l.posting_role is distinct from x.role::posting_role;

update ledger_account l
set control_account_id = c.id
from control_account c
where l.tenant_id = c.tenant_id
  and l.code = '940'
  and c.code = '80';

do $$
begin
  if exists (
    select 1
    from tenant t
    where (
      select count(*)
      from ledger_account l
      where l.tenant_id = t.id
        and l.posting_role in (
          'quality_deduction','rate_difference','shortage_claim',
          'brokerage_accrued','tds_payable','tds_receivable'
        )
    ) <> 6
  ) then
    raise exception 'demo tenant is missing a required kapat/brokerage ledger';
  end if;
end $$;

commit;
