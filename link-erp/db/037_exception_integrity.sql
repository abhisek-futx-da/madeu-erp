-- Exception documents must retain the amount that was approved and the voucher
-- that posted it.  Earlier migrations created the headers but the server wrote
-- columns that did not exist, so a clean database could not post a customer
-- return at all.

alter table customer_return
  add column if not exists challan_no text not null default '',
  add column if not exists challan_date date,
  add column if not exists amount numeric(14,2) not null default 0,
  add column if not exists voucher_id uuid references voucher(id);

alter table grey_return
  add column if not exists amount numeric(14,2) not null default 0,
  add column if not exists voucher_id uuid references voucher(id);

alter table dyeing_return
  add column if not exists amount numeric(14,2) not null default 0,
  add column if not exists voucher_id uuid references voucher(id);

alter table write_off
  add column if not exists amount numeric(14,2) not null default 0;

-- Every tenant-scoped detail table gets its own tenant key and RLS policy.
-- This keeps direct SQL from using a known write-off ID to cross a tenant
-- boundary, and lets indexes/reporting remain tenant-local.
alter table write_off_line add column if not exists tenant_id uuid;
update write_off_line l set tenant_id = h.tenant_id
  from write_off h where h.id = l.write_off_id and l.tenant_id is null;
alter table write_off_line alter column tenant_id set not null;
alter table write_off_line
  add constraint write_off_line_tenant_fk foreign key (tenant_id) references tenant(id) on delete cascade;
create index if not exists write_off_line_tenant_write_off_idx
  on write_off_line (tenant_id, write_off_id);

alter table write_off enable row level security;
alter table write_off_line enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = current_schema()
                 and tablename = 'write_off' and policyname = 'tenant_isolation') then
    create policy tenant_isolation on write_off
      using (tenant_id = current_setting('app.tenant_id', true)::uuid)
      with check (tenant_id = current_setting('app.tenant_id', true)::uuid);
  end if;
  if not exists (select 1 from pg_policies where schemaname = current_schema()
                 and tablename = 'write_off_line' and policyname = 'tenant_isolation') then
    create policy tenant_isolation on write_off_line
      using (tenant_id = current_setting('app.tenant_id', true)::uuid)
      with check (tenant_id = current_setting('app.tenant_id', true)::uuid);
  end if;
end $$;

grant select, insert, update, delete on write_off, write_off_line to link_erp_app;
