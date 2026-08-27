-- Seed pass for the clearing accounts. Migration 068 runs before 003_seed
-- creates the demo tenant, so it finds nothing to give ledgers to; tenants
-- made through the API get theirs from the bootstrap transaction. This covers
-- the demo tenant, and is the same statements written to be safe to re-run.

insert into control_account (tenant_id, code, name, sub_control, nature)
select id, '11', 'Received Not Billed', 'Current Liabilities', 'current_liability'
  from tenant
 on conflict (tenant_id, code) do nothing;

insert into ledger_account (tenant_id, code, name, control_account_id, gst_reg_type)
select t.id, x.code, x.name, c.id, 'unregistered'
  from tenant t
  join (values
    ('991', 'Grey Received — Not Yet Billed'),
    ('992', 'Job Work Done — Not Yet Billed')
  ) as x(code, name) on true
  join control_account c on c.tenant_id = t.id and c.code = '11'
 on conflict (tenant_id, code) do nothing;

update ledger_account l set posting_role = x.role::posting_role
  from (values ('991', 'grey_not_billed'), ('992', 'jobwork_not_billed')) as x(code, role)
 where l.code = x.code
   and l.posting_role is distinct from x.role::posting_role;

-- Nothing may post grey or job work without somewhere to accrue it.
do $$
begin
  if exists (
    select 1 from tenant t
     where (select count(*) from ledger_account l
             where l.tenant_id = t.id
               and l.posting_role in ('grey_not_billed', 'jobwork_not_billed')) <> 2
  ) then
    raise exception 'a tenant is missing a received-not-billed ledger';
  end if;
end $$;
