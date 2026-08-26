-- Phase 1 commercial foundation: locations, configurable access profiles,
-- controlled opening data and personal report views.  These are cutover
-- controls: an opening import is evidence, not an editable master shortcut.

-- ------------------------------------------------------- business locations --

create type business_location_kind as enum ('registered_office','branch','godown','outlet');

create table business_location (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenant(id) on delete cascade,
  code        text not null,
  name        text not null,
  kind        business_location_kind not null default 'godown',
  gstin       char(15),
  address     text not null default '',
  state_code  char(2) not null,
  is_default  boolean not null default false,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  unique (tenant_id, code),
  unique (id, tenant_id),
  constraint business_location_gstin_shape check (
    gstin is null or gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{3}$'
  )
);
create unique index business_location_one_default
  on business_location(tenant_id) where is_default;

insert into business_location (tenant_id,code,name,kind,gstin,state_code,is_default)
select id,'MAIN','Main office / godown','registered_office',gstin,state_code,true
  from tenant
on conflict (tenant_id,code) do nothing;

alter table membership
  add column active_location_id uuid,
  add constraint membership_active_location_fk
    foreign key (active_location_id,tenant_id)
    references business_location(id,tenant_id);

update membership m set active_location_id=l.id
  from business_location l
 where l.tenant_id=m.tenant_id and l.is_default and m.active_location_id is null;

alter table rack_master add column business_location_id uuid;
update rack_master r set business_location_id=l.id
  from business_location l
 where l.tenant_id=r.tenant_id and l.is_default and r.business_location_id is null;
alter table rack_master
  alter column business_location_id set not null,
  add constraint rack_business_location_fk
    foreign key (business_location_id,tenant_id)
    references business_location(id,tenant_id);
create index rack_by_location on rack_master(tenant_id,business_location_id,code);

-- Old creation paths pre-date locations.  Keep them safe during an upgrade:
-- a rack without an explicit location belongs to the tenant's one default
-- location.  The application may name another active location, but it may
-- never smuggle a rack across tenants or into a disabled location.
create or replace function rack_business_location_default()
returns trigger language plpgsql as $$
begin
  if new.business_location_id is null then
    select id into new.business_location_id from business_location
     where tenant_id=new.tenant_id and is_default and is_active;
  end if;
  if not exists (select 1 from business_location
                  where id=new.business_location_id and tenant_id=new.tenant_id and is_active) then
    raise exception 'rack business location is not active for this company';
  end if;
  return new;
end;
$$;
create trigger rack_business_location_default
  before insert or update of tenant_id,business_location_id on rack_master
  for each row execute function rack_business_location_default();

alter table piece add column business_location_id uuid;
update piece p set business_location_id=coalesce(
       (select r.business_location_id from rack_master r
         where r.tenant_id=p.tenant_id and r.code=p.rack_code),l.id)
  from business_location l
 where l.tenant_id=p.tenant_id and l.is_default and p.business_location_id is null;
alter table piece
  alter column business_location_id set not null,
  add constraint piece_business_location_fk
    foreign key (business_location_id,tenant_id)
    references business_location(id,tenant_id);
create index piece_by_location on piece(tenant_id,business_location_id,status);

-- A piece follows its rack.  Unracked legacy and API inserts use the default
-- location, which preserves every pre-location inward/regroup path while the
-- caller is upgraded to pass an explicit location.
create or replace function piece_business_location_default()
returns trigger language plpgsql as $$
declare rack_location uuid;
begin
  if new.rack_code is not null then
    select business_location_id into rack_location from rack_master
     where tenant_id=new.tenant_id and code=new.rack_code;
    if rack_location is null then raise exception 'piece rack is not known for this company'; end if;
    if new.business_location_id is not null and new.business_location_id<>rack_location then
      raise exception 'piece location does not match its rack';
    end if;
    new.business_location_id := rack_location;
  elsif new.business_location_id is null then
    select id into new.business_location_id from business_location
     where tenant_id=new.tenant_id and is_default and is_active;
  end if;
  if not exists (select 1 from business_location
                  where id=new.business_location_id and tenant_id=new.tenant_id and is_active) then
    raise exception 'piece business location is not active for this company';
  end if;
  return new;
end;
$$;
create trigger piece_business_location_default
  before insert or update of tenant_id,business_location_id,rack_code on piece
  for each row execute function piece_business_location_default();

-- Future tenants get the same safe defaults without handwritten SQL.
create or replace function create_tenant_commercial_defaults()
returns trigger language plpgsql as $$
begin
  insert into business_location
    (tenant_id,code,name,kind,gstin,state_code,is_default)
  values (new.id,'MAIN','Main office / godown','registered_office',
          new.gstin,new.state_code,true);
  return new;
end;
$$;
create trigger tenant_commercial_defaults
  after insert on tenant for each row execute function create_tenant_commercial_defaults();

-- ----------------------------------------------------- permission profiles --

create table permission_profile (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenant(id) on delete cascade,
  code        text not null,
  name        text not null,
  base_role   member_role not null,
  permissions text[] not null default '{}',
  is_system   boolean not null default false,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  unique (tenant_id,code),
  unique (id,tenant_id),
  constraint permission_profile_known_areas check (
    permissions <@ array[
      'write:masters','write:purchase','write:store',
      'write:sales','write:accounts','write:owner'
    ]::text[]
  )
);

insert into permission_profile (tenant_id,code,name,base_role,permissions,is_system)
select t.id, x.code, x.name, x.role::member_role, x.permissions, true
  from tenant t
 cross join (values
   ('OWNER','Owner','owner',array['write:masters','write:purchase','write:store','write:sales','write:accounts','write:owner']::text[]),
   ('ACCOUNTS','Accounts','accounts',array['write:masters','write:accounts']::text[]),
   ('PURCHASE','Purchase','purchase',array['write:masters','write:purchase','write:store']::text[]),
   ('SALES','Sales','sales',array['write:masters','write:sales']::text[]),
   ('STORE','Store','store',array['write:store']::text[]),
   ('VIEWER','Read only','viewer',array[]::text[])
 ) as x(code,name,role,permissions)
on conflict (tenant_id,code) do nothing;

alter table membership add column permission_profile_id uuid;
update membership m set permission_profile_id=p.id
  from permission_profile p
 where p.tenant_id=m.tenant_id and p.base_role=m.role and p.is_system
   and m.permission_profile_id is null;
alter table membership
  alter column permission_profile_id set not null,
  add constraint membership_permission_profile_fk
    foreign key (permission_profile_id,tenant_id)
    references permission_profile(id,tenant_id);
create index membership_by_profile on membership(tenant_id,permission_profile_id);
create index membership_by_active_location on membership(tenant_id,active_location_id);

create or replace function create_tenant_permission_profiles()
returns trigger language plpgsql as $$
begin
  insert into permission_profile (tenant_id,code,name,base_role,permissions,is_system)
  values
    (new.id,'OWNER','Owner','owner',array['write:masters','write:purchase','write:store','write:sales','write:accounts','write:owner'],true),
    (new.id,'ACCOUNTS','Accounts','accounts',array['write:masters','write:accounts'],true),
    (new.id,'PURCHASE','Purchase','purchase',array['write:masters','write:purchase','write:store'],true),
    (new.id,'SALES','Sales','sales',array['write:masters','write:sales'],true),
    (new.id,'STORE','Store','store',array['write:store'],true),
    (new.id,'VIEWER','Read only','viewer',array[]::text[],true);
  return new;
end;
$$;
create trigger tenant_permission_profiles
  after insert on tenant for each row execute function create_tenant_permission_profiles();

-- Membership inserts exist in seed, bootstrap and staff-administration paths.
-- Resolve their safe system profile and default location in the database so a
-- missed caller cannot create a half-authorised account.  A custom profile is
-- accepted only when it is active, belongs to this tenant and agrees with the
-- membership's base role.
create or replace function membership_commercial_defaults()
returns trigger language plpgsql as $$
declare profile_role member_role; profile_active boolean; location_active boolean;
begin
  if new.permission_profile_id is null
     or (tg_op='UPDATE' and new.role is distinct from old.role
         and new.permission_profile_id is not distinct from old.permission_profile_id) then
    select id into new.permission_profile_id from permission_profile
     where tenant_id=new.tenant_id and base_role=new.role and is_system and is_active
     order by code limit 1;
  end if;
  select base_role,is_active into profile_role,profile_active from permission_profile
   where id=new.permission_profile_id and tenant_id=new.tenant_id;
  if profile_role is null or not profile_active or profile_role<>new.role then
    raise exception 'permission profile is not active for this company and role';
  end if;

  if new.active_location_id is null then
    select id into new.active_location_id from business_location
     where tenant_id=new.tenant_id and is_default and is_active;
  end if;
  select is_active into location_active from business_location
   where id=new.active_location_id and tenant_id=new.tenant_id;
  if location_active is distinct from true then
    raise exception 'active location is not available for this company';
  end if;
  return new;
end;
$$;
create trigger membership_commercial_defaults
  before insert or update of tenant_id,role,permission_profile_id,active_location_id on membership
  for each row execute function membership_commercial_defaults();

-- Login and every authenticated request can read current authority without
-- bypassing tenant RLS broadly.  This is deliberately a narrow definer
-- function, like user_memberships(), and returns no unrelated company data.
create function user_membership_state(p_user uuid,p_tenant uuid)
returns table (role member_role,permissions text[],active_location_id uuid,active_location_name text)
language sql stable security definer set search_path=public as $$
  select m.role,p.permissions,m.active_location_id,l.name
    from membership m
    join permission_profile p on p.id=m.permission_profile_id and p.tenant_id=m.tenant_id
    join business_location l on l.id=m.active_location_id and l.tenant_id=m.tenant_id
   where m.user_id=p_user and m.tenant_id=p_tenant and m.is_active
     and p.is_active and l.is_active;
$$;
revoke all on function user_membership_state(uuid,uuid) from public;
grant execute on function user_membership_state(uuid,uuid) to link_erp_app;

-- There must always be one live default.  The check is deferred so changing
-- the default can clear the old row and set the new row in one transaction.
create or replace function business_location_requires_default()
returns trigger language plpgsql as $$
declare affected_tenant uuid := coalesce(new.tenant_id,old.tenant_id);
begin
  if not exists (select 1 from business_location
                  where tenant_id=affected_tenant and is_default and is_active) then
    raise exception 'a company must retain one active default business location';
  end if;
  return null;
end;
$$;
create constraint trigger business_location_requires_default
  after insert or update or delete on business_location
  deferrable initially deferred for each row execute function business_location_requires_default();

-- ---------------------------------------------------------- saved reports --

create table saved_view (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenant(id) on delete cascade,
  user_id     uuid not null references app_user(id) on delete cascade,
  module      text not null,
  name        text not null,
  filter_text text not null default '',
  columns     text[] not null default '{}',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id,user_id,module,name)
);
create index saved_view_by_module on saved_view(tenant_id,user_id,module,name);

-- --------------------------------------------------------- opening bills --

create type opening_outstanding_kind as enum ('receivable','payable');
create type opening_outstanding_status as enum ('open','cancelled');

create table opening_outstanding (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  fy_label      text not null,
  kind          opening_outstanding_kind not null,
  party_id      uuid not null,
  reference_no  text not null,
  document_date date not null,
  due_date      date not null,
  original_amount numeric(14,2) not null check (original_amount > 0),
  import_id     uuid,
  created_by    uuid not null references app_user(id),
  status        opening_outstanding_status not null default 'open',
  created_at    timestamptz not null default now(),
  unique (tenant_id,kind,party_id,reference_no),
  foreign key (tenant_id,fy_label) references financial_year(tenant_id,label),
  foreign key (import_id,tenant_id) references data_import(id,tenant_id)
);
alter table ledger_account add constraint ledger_account_id_tenant_unique unique(id,tenant_id);
alter table opening_outstanding add constraint opening_outstanding_party_tenant_fk
  foreign key (party_id,tenant_id) references ledger_account(id,tenant_id);
alter table opening_outstanding add constraint opening_outstanding_id_tenant_unique unique(id,tenant_id);
create index opening_outstanding_by_party
  on opening_outstanding(tenant_id,kind,party_id,document_date);
create index opening_outstanding_party_fk
  on opening_outstanding(tenant_id,party_id);
create index opening_outstanding_import_fk
  on opening_outstanding(tenant_id,import_id) where import_id is not null;

create or replace function opening_outstanding_guard()
returns trigger language plpgsql as $$
declare party_nature account_nature;
begin
  if exists (select 1 from voucher where tenant_id=new.tenant_id and is_posted) then
    raise exception 'opening bills are locked after the first posted voucher';
  end if;
  select c.nature into party_nature from ledger_account l
    join control_account c on c.id=l.control_account_id
   where l.id=new.party_id and l.tenant_id=new.tenant_id;
  if (new.kind='receivable' and party_nature<>'sundry_debtor_finish') or
     (new.kind='payable' and party_nature not in (
       'sundry_creditor_grey','sundry_creditor_process','sundry_creditor_finish',
       'sundry_creditor_brokerage','sundry_creditor_transport','sundry_creditor_expense')) then
    raise exception 'opening bill party does not match its receivable/payable direction';
  end if;
  return new;
end;
$$;
create trigger opening_outstanding_guard before insert on opening_outstanding
for each row execute function opening_outstanding_guard();

alter table payment_allocation add column opening_outstanding_id uuid;
alter table payment_allocation add constraint allocation_opening_tenant_fk
  foreign key (opening_outstanding_id,tenant_id) references opening_outstanding(id,tenant_id);
alter table payment_allocation drop constraint allocation_one_target;
alter table payment_allocation add constraint allocation_one_target check (
  (sales_invoice_id is not null)::int +
  (purchase_invoice_id is not null)::int +
  (opening_outstanding_id is not null)::int = 1
);
create index allocation_by_opening on payment_allocation(opening_outstanding_id)
  where opening_outstanding_id is not null;

drop trigger if exists payment_allocation_party_guard on payment_allocation;
create or replace function allocation_matches_payment_party() returns trigger as $$
declare
  payment_tenant uuid;
  payment_party uuid;
  payment_kind payment_kind;
  invoice_tenant uuid;
  invoice_party uuid;
  opening_kind opening_outstanding_kind;
begin
  select tenant_id,party_id,kind into payment_tenant,payment_party,payment_kind
    from payment where id=new.payment_id;
  if new.sales_invoice_id is not null then
    select tenant_id,party_id into invoice_tenant,invoice_party
      from sales_invoice where id=new.sales_invoice_id and status<>'cancelled';
    if payment_kind<>'receipt' then raise exception 'sales invoices require a receipt'; end if;
  elsif new.purchase_invoice_id is not null then
    select tenant_id,party_id into invoice_tenant,invoice_party
      from purchase_invoice where id=new.purchase_invoice_id and status<>'cancelled';
    if payment_kind<>'payment' then raise exception 'purchase invoices require a payment'; end if;
  else
    select tenant_id,party_id,kind into invoice_tenant,invoice_party,opening_kind
      from opening_outstanding where id=new.opening_outstanding_id and status='open';
    if (payment_kind='receipt' and opening_kind<>'receivable') or
       (payment_kind='payment' and opening_kind<>'payable') then
      raise exception 'opening bill type does not match payment direction';
    end if;
  end if;
  if invoice_tenant is null then raise exception 'live allocation target not found'; end if;
  if new.tenant_id<>payment_tenant or invoice_tenant<>payment_tenant then
    raise exception 'payment allocation crosses tenants';
  end if;
  if invoice_party<>payment_party then
    raise exception 'payment party does not own the allocated bill';
  end if;
  return new;
end $$ language plpgsql;
create trigger payment_allocation_party_guard before insert or update on payment_allocation
for each row execute function allocation_matches_payment_party();

create or replace function allocation_within_opening_bill() returns trigger as $$
declare bill numeric(14,2); allocated numeric(14,2);
begin
  if new.opening_outstanding_id is null then return null; end if;
  select original_amount into bill from opening_outstanding
   where id=new.opening_outstanding_id and status='open';
  select coalesce(sum(a.amount),0) into allocated
    from payment_allocation a join payment p on p.id=a.payment_id
   where a.opening_outstanding_id=new.opening_outstanding_id
     and p.status in ('approved','pending_approval');
  if allocated > bill + 0.005 then
    raise exception 'allocations (%) exceed the opening bill (%)',allocated,bill;
  end if;
  return null;
end $$ language plpgsql;
create constraint trigger allocation_fits_opening_bill
  after insert or update on payment_allocation deferrable initially deferred
  for each row execute function allocation_within_opening_bill();

create or replace view v_outstanding_sales as
with combined as (
  select i.tenant_id,i.id as invoice_id,i.invoice_no,i.invoice_date,i.created_at,
         p.code,p.name as party,p.credit_days,i.invoice_total,
         coalesce(a.paid,0) as paid,coalesce(n.credited,0) as credited,
         i.invoice_total-coalesce(a.paid,0)-coalesce(n.credited,0) as outstanding,
         greatest(0,current_date-i.invoice_date) as age_days,
         greatest(0,(current_date-i.invoice_date)-coalesce(p.credit_days,0)) as overdue_days,
         i.party_id,'invoice'::text as source_kind
    from sales_invoice i join ledger_account p on p.id=i.party_id
    left join lateral (
      select sum(al.amount) as paid from payment_allocation al
      join payment pay on pay.id=al.payment_id and pay.status='approved'
      where al.sales_invoice_id=i.id
    ) a on true
    left join lateral (
      select sum(case when gn.note_kind='credit' then gn.note_total else -gn.note_total end) as credited
        from gst_note gn where gn.against_invoice_id=i.id and gn.status<>'cancelled'
    ) n on true
   where i.status<>'cancelled'
     and i.tenant_id=current_setting('app.tenant_id',true)::uuid
  union all
  select o.tenant_id,o.id,o.reference_no,o.document_date,o.created_at,
         p.code,p.name,p.credit_days,o.original_amount,
         coalesce(a.paid,0),0::numeric,o.original_amount-coalesce(a.paid,0),
         greatest(0,current_date-o.document_date),greatest(0,current_date-o.due_date),
         o.party_id,'opening'::text
    from opening_outstanding o join ledger_account p on p.id=o.party_id
    left join lateral (
      select sum(al.amount) as paid from payment_allocation al
      join payment pay on pay.id=al.payment_id and pay.status='approved'
      where al.opening_outstanding_id=o.id
    ) a on true
   where o.kind='receivable' and o.status='open'
     and o.tenant_id=current_setting('app.tenant_id',true)::uuid
)
select tenant_id,invoice_id,invoice_no,invoice_date,created_at,code,party,credit_days,
       invoice_total::numeric(14,2) as invoice_total,paid,
       credited,outstanding,
       age_days,overdue_days,party_id,source_kind from combined;

create or replace view v_outstanding_purchases as
with combined as (
  select pi.tenant_id,pi.id as invoice_id,pi.our_ref,pi.supplier_invoice_no,
         pi.invoice_date,pi.created_at,l.code,l.name as party,pi.invoice_total,
         coalesce(a.paid,0) as paid,pi.invoice_total-coalesce(a.paid,0) as outstanding,
         greatest(0,current_date-pi.invoice_date) as age_days,pi.party_id,'invoice'::text as source_kind
    from purchase_invoice pi join ledger_account l on l.id=pi.party_id
    left join lateral (
      select sum(al.amount) as paid from payment_allocation al
      join payment pay on pay.id=al.payment_id and pay.status='approved'
      where al.purchase_invoice_id=pi.id
    ) a on true
   where pi.status<>'cancelled'
     and pi.tenant_id=current_setting('app.tenant_id',true)::uuid
  union all
  select o.tenant_id,o.id,o.reference_no,o.reference_no,o.document_date,o.created_at,
         p.code,p.name,o.original_amount,coalesce(a.paid,0),
         o.original_amount-coalesce(a.paid,0),greatest(0,current_date-o.document_date),
         o.party_id,'opening'::text
    from opening_outstanding o join ledger_account p on p.id=o.party_id
    left join lateral (
      select sum(al.amount) as paid from payment_allocation al
      join payment pay on pay.id=al.payment_id and pay.status='approved'
      where al.opening_outstanding_id=o.id
    ) a on true
   where o.kind='payable' and o.status='open'
     and o.tenant_id=current_setting('app.tenant_id',true)::uuid
)
select tenant_id,invoice_id,our_ref,supplier_invoice_no,invoice_date,created_at,code,party,
       invoice_total::numeric(14,2) as invoice_total,paid,
       outstanding,age_days,party_id,source_kind from combined;

create or replace view v_receivable_ageing as
select tenant_id,code,party,invoice_no,invoice_date,
       outstanding::numeric(14,2) as invoice_total,
       credit_days::integer as credit_days,age_days,overdue_days,
       case when age_days<=30 then '0-30' when age_days<=60 then '31-60'
            when age_days<=90 then '61-90' when age_days<=180 then '91-180'
            else '180+' end as bucket
  from v_outstanding_sales where outstanding>0.005;

-- -------------------------------------------------------- import lifecycle --

alter table data_import drop constraint data_import_resource_check;
alter table data_import add constraint data_import_resource_check check (resource in (
  'grades','hsn-codes','units','widths','racks','qualities','ledgers'
));

-- -------------------------------------------------------------- security --

alter table business_location enable row level security;
alter table business_location force row level security;
create policy tenant_isolation on business_location
  using (tenant_id=current_setting('app.tenant_id',true)::uuid)
  with check (tenant_id=current_setting('app.tenant_id',true)::uuid);

alter table permission_profile enable row level security;
alter table permission_profile force row level security;
create policy tenant_isolation on permission_profile
  using (tenant_id=current_setting('app.tenant_id',true)::uuid)
  with check (tenant_id=current_setting('app.tenant_id',true)::uuid);

alter table saved_view enable row level security;
alter table saved_view force row level security;
create policy own_saved_views on saved_view
  using (tenant_id=current_setting('app.tenant_id',true)::uuid
         and user_id=current_setting('app.user_id',true)::uuid)
  with check (tenant_id=current_setting('app.tenant_id',true)::uuid
              and user_id=current_setting('app.user_id',true)::uuid);

alter table opening_outstanding enable row level security;
alter table opening_outstanding force row level security;
create policy tenant_isolation on opening_outstanding
  using (tenant_id=current_setting('app.tenant_id',true)::uuid)
  with check (tenant_id=current_setting('app.tenant_id',true)::uuid);

grant select,insert,update on business_location,permission_profile,saved_view,opening_outstanding
  to link_erp_app;
grant delete on saved_view to link_erp_app;
grant select on v_outstanding_sales,v_outstanding_purchases,v_receivable_ageing
  to link_erp_app;
