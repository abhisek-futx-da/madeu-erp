-- Opening balances are part of a financial year, not a convenience field on
-- a ledger.  This migration makes that relationship enforceable, brings any
-- legacy signed ledger openings into the current year, and makes every voucher
-- belong to an explicitly configured open year.

alter type fy_status add value if not exists 'pending';

-- Older builds allowed closeFinancialYear to write openings for a label that
-- had no financial_year row.  Materialise those years before adding the FK so
-- an additive production migration remains safe.
insert into financial_year (tenant_id, label, starts_on, ends_on, status)
select distinct ob.tenant_id, ob.fy_label,
       make_date(split_part(ob.fy_label, '-', 1)::integer, 4, 1),
       make_date(split_part(ob.fy_label, '-', 1)::integer + 1, 3, 31),
       'open'::fy_status
  from opening_balance ob
 where ob.fy_label ~ '^\d{4}-\d{2}$'
   and not exists (
     select 1 from financial_year fy
      where fy.tenant_id = ob.tenant_id and fy.label = ob.fy_label
   );

-- Preserve any opening entered through the old ledger form.  The historical
-- convention was positive = debit and negative = credit.  New UI/API paths
-- use explicit debit and credit columns and never write this legacy field.
insert into opening_balance (tenant_id, fy_label, ledger_id, debit, credit)
select la.tenant_id, fy.label, la.id,
       case when la.opening_balance > 0 then la.opening_balance else 0 end,
       case when la.opening_balance < 0 then -la.opening_balance else 0 end
  from ledger_account la
  join lateral (
    select label from financial_year fy
     where fy.tenant_id = la.tenant_id and fy.status = 'open'
     order by starts_on desc limit 1
  ) fy on true
 where abs(la.opening_balance) > 0.005
on conflict (tenant_id, fy_label, ledger_id) do nothing;

alter table opening_balance
  drop constraint if exists opening_balance_financial_year_fk,
  add constraint opening_balance_financial_year_fk
    foreign key (tenant_id, fy_label)
    references financial_year(tenant_id, label)
    on delete cascade;

create index if not exists opening_balance_by_year
  on opening_balance (tenant_id, fy_label, ledger_id);

create table if not exists opening_balance_revision (
  id           bigint generated always as identity primary key,
  tenant_id    uuid not null references tenant(id) on delete cascade,
  fy_label     text not null,
  created_by   uuid not null references app_user(id),
  total_debit  numeric(14,2) not null,
  total_credit numeric(14,2) not null,
  entries      jsonb not null,
  occurred_at  timestamptz not null default now(),
  foreign key (tenant_id, fy_label)
    references financial_year(tenant_id, label)
);

create index if not exists opening_revision_by_year
  on opening_balance_revision (tenant_id, fy_label, occurred_at desc);

alter table opening_balance_revision enable row level security;
create policy tenant_isolation on opening_balance_revision
  using (tenant_id = current_setting('app.tenant_id', true)::uuid)
  with check (tenant_id = current_setting('app.tenant_id', true)::uuid);

grant select, insert on opening_balance_revision to link_erp_app;
grant usage, select on sequence opening_balance_revision_id_seq to link_erp_app;

create or replace function prevent_opening_revision_rewrite()
returns trigger language plpgsql as $$
begin
  raise exception 'opening balance revisions are append-only';
end;
$$;

create trigger opening_revision_no_rewrite
  before update or delete on opening_balance_revision
  for each row execute function prevent_opening_revision_rewrite();

create table if not exists configuration_audit (
  id          bigint generated always as identity primary key,
  tenant_id   uuid not null references tenant(id) on delete cascade,
  actor_id    uuid not null references app_user(id),
  area        text not null,
  event       text not null,
  details     jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);

create index if not exists configuration_audit_by_time
  on configuration_audit (tenant_id, occurred_at desc);

alter table configuration_audit enable row level security;
create policy tenant_isolation on configuration_audit
  using (tenant_id = current_setting('app.tenant_id', true)::uuid)
  with check (tenant_id = current_setting('app.tenant_id', true)::uuid);

grant select, insert on configuration_audit to link_erp_app;
grant usage, select on sequence configuration_audit_id_seq to link_erp_app;

create trigger configuration_audit_no_rewrite
  before update or delete on configuration_audit
  for each row execute function prevent_opening_revision_rewrite();

-- A voucher outside a configured year is just as dangerous as one inside a
-- closed year.  Require exactly one matching open year for every posting.
create or replace function voucher_year_is_open() returns trigger as $$
declare matched financial_year%rowtype;
begin
  select * into matched
    from financial_year
   where tenant_id = new.tenant_id
     and new.voucher_date between starts_on and ends_on;

  if matched.label is null then
    raise exception 'no financial year is configured for %', new.voucher_date;
  end if;
  if matched.status <> 'open' then
    raise exception 'financial year % is %; cannot post on %',
      matched.label, matched.status, new.voucher_date;
  end if;
  return new;
end $$ language plpgsql;

-- The current-year trial balance includes explicit openings plus movements
-- inside that same year.  The old view silently omitted openings and mixed all
-- financial years together.
create or replace view v_trial_balance as
with fy as (
  select tenant_id, label, starts_on, ends_on
    from financial_year
   where tenant_id = current_setting('app.tenant_id', true)::uuid
     and status = 'open'
   order by starts_on desc
   limit 1
), entries as (
  select ob.tenant_id, ob.ledger_id, ob.debit, ob.credit
    from opening_balance ob
    join fy on fy.tenant_id = ob.tenant_id and fy.label = ob.fy_label
  union all
  select vl.tenant_id, vl.ledger_id, vl.debit, vl.credit
    from voucher_line vl
    join voucher v on v.id = vl.voucher_id and v.is_posted
    join fy on fy.tenant_id = vl.tenant_id
            and v.voucher_date between fy.starts_on and fy.ends_on
)
select e.tenant_id, la.code, la.name, ca.name as control_account, ca.nature,
       sum(e.debit) as total_debit,
       sum(e.credit) as total_credit,
       sum(e.debit) - sum(e.credit) as balance
  from entries e
  join ledger_account la on la.id = e.ledger_id
  join control_account ca on ca.id = la.control_account_id
 group by e.tenant_id, la.code, la.name, ca.name, ca.nature;

grant select on v_trial_balance to link_erp_app;
