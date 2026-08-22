-- TDS/TCS, the financial year and its close, and GSTR-2B reconciliation.

-- ------------------------------------------------------------- TDS / TCS --

create type deduction_kind as enum ('tds', 'tcs');

-- Two different threshold rules exist in the Act and they are not the same:
-- 194Q and 206C(1H) charge only on the excess over the threshold, while 194C
-- charges on the whole amount once the threshold has been crossed.
create type threshold_basis as enum ('excess_over_threshold', 'full_once_crossed');

create table tax_deduction_section (
  tenant_id       uuid not null references tenant(id) on delete cascade,
  code            text not null,
  kind            deduction_kind not null,
  description     text not null,
  rate            numeric(5,3) not null,
  rate_no_pan     numeric(5,3) not null,
  threshold       numeric(14,2) not null default 0,
  basis           threshold_basis not null,
  applies_to      text not null,
  primary key (tenant_id, code),
  constraint deduction_rate_sane check (rate >= 0 and rate <= 100 and rate_no_pan >= rate),
  constraint deduction_applies_to check (applies_to in ('purchase', 'sales'))
);

alter table ledger_account add column tds_section text;
alter table ledger_account add constraint ledger_tds_section_fk
  foreign key (tenant_id, tds_section) references tax_deduction_section(tenant_id, code);

create table tax_deduction (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenant(id) on delete cascade,
  section_code    text not null,
  kind            deduction_kind not null,
  party_id        uuid not null references ledger_account(id),
  doc_type        text not null,
  doc_id          uuid not null,
  doc_date        date not null,
  fy_label        text not null,
  base_amount     numeric(14,2) not null,
  chargeable      numeric(14,2) not null,
  rate            numeric(5,3) not null,
  amount          numeric(14,2) not null,
  voucher_id      uuid references voucher(id),
  created_at      timestamptz not null default now(),
  unique (tenant_id, doc_type, doc_id, section_code),
  constraint deduction_amount_sane check (amount >= 0 and chargeable <= base_amount)
);

create index tax_deduction_by_party_fy on tax_deduction (tenant_id, party_id, section_code, fy_label);

-- ------------------------------------------------------- the financial year --

create type fy_status as enum ('open', 'closing', 'closed');

create table financial_year (
  tenant_id     uuid not null references tenant(id) on delete cascade,
  label         text not null,
  starts_on     date not null,
  ends_on       date not null,
  status        fy_status not null default 'open',
  closed_at     timestamptz,
  closed_by     uuid references app_user(id),
  primary key (tenant_id, label),
  constraint fy_dates check (ends_on > starts_on)
);

create table opening_balance (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  fy_label      text not null,
  ledger_id     uuid not null references ledger_account(id),
  debit         numeric(14,2) not null default 0,
  credit        numeric(14,2) not null default 0,
  unique (tenant_id, fy_label, ledger_id),
  constraint opening_one_side check ((debit = 0) or (credit = 0))
);

/**
 * Nothing may be posted into a year that has been closed. This is the whole
 * point of closing one, and it belongs in the database rather than in a
 * service anyone could bypass.
 */
create or replace function voucher_year_is_open() returns trigger as $$
declare closed_label text;
begin
  select label into closed_label
    from financial_year
   where tenant_id = new.tenant_id
     and status = 'closed'
     and new.voucher_date between starts_on and ends_on;

  if closed_label is not null then
    raise exception 'financial year % is closed; cannot post on %', closed_label, new.voucher_date;
  end if;
  return new;
end $$ language plpgsql;

create trigger voucher_respects_closed_year
  before insert or update on voucher
  for each row execute function voucher_year_is_open();

-- --------------------------------------------------------------- GSTR-2B --

-- What the portal says our suppliers filed, imported and matched against what
-- we booked. The gap between the two is the input credit we cannot claim.
create table gstr2b_line (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenant(id) on delete cascade,
  return_period     text not null,
  supplier_gstin    char(15) not null,
  supplier_name     text,
  invoice_no        text not null,
  invoice_date      date not null,
  taxable_value     numeric(14,2) not null,
  cgst_amount       numeric(14,2) not null default 0,
  sgst_amount       numeric(14,2) not null default 0,
  igst_amount       numeric(14,2) not null default 0,
  itc_available     boolean not null default true,
  imported_at       timestamptz not null default now(),
  unique (tenant_id, return_period, supplier_gstin, invoice_no)
);

-- A full outer join: what they filed, what we booked, and where they disagree.
create view v_gstr2b_reconciliation as
with theirs as (
  select return_period, supplier_gstin, invoice_no, invoice_date,
         taxable_value, cgst_amount + sgst_amount + igst_amount as tax
    from gstr2b_line
   where tenant_id = current_setting('app.tenant_id', true)::uuid
), ours as (
  select to_char(pi.invoice_date, 'MM-YYYY') as return_period,
         la.gstin as supplier_gstin, pi.supplier_invoice_no as invoice_no,
         pi.invoice_date, pi.taxable_value,
         pi.cgst_amount + pi.sgst_amount + pi.igst_amount as tax
    from purchase_invoice pi
    join ledger_account la on la.id = pi.party_id
   where pi.status <> 'cancelled' and la.gstin is not null
     and pi.tenant_id = current_setting('app.tenant_id', true)::uuid
)
select
  coalesce(t.return_period, o.return_period)   as return_period,
  coalesce(t.supplier_gstin, o.supplier_gstin) as supplier_gstin,
  coalesce(t.invoice_no, o.invoice_no)         as invoice_no,
  coalesce(t.invoice_date, o.invoice_date)     as invoice_date,
  t.taxable_value as portal_taxable, t.tax as portal_tax,
  o.taxable_value as books_taxable,  o.tax as books_tax,
  case
    when o.invoice_no is null then 'missing_in_books'
    when t.invoice_no is null then 'missing_in_portal'
    when abs(coalesce(t.taxable_value,0) - coalesce(o.taxable_value,0)) > 1
      or abs(coalesce(t.tax,0) - coalesce(o.tax,0)) > 1 then 'value_mismatch'
    else 'matched'
  end as status,
  coalesce(o.tax, 0) - coalesce(t.tax, 0) as credit_at_risk
  from theirs t
  full join ours o
    on o.supplier_gstin = t.supplier_gstin
   and upper(trim(o.invoice_no)) = upper(trim(t.invoice_no));

create view v_tds_summary as
select d.tenant_id, d.fy_label, d.section_code, d.kind, l.name as party,
       count(*)            as documents,
       sum(d.base_amount)  as base_amount,
       sum(d.chargeable)   as chargeable,
       sum(d.amount)       as deducted
  from tax_deduction d
  join ledger_account l on l.id = d.party_id
 where d.tenant_id = current_setting('app.tenant_id', true)::uuid
 group by d.tenant_id, d.fy_label, d.section_code, d.kind, l.name;

-- ------------------------------------------------------------ privileges --

do $$
declare t text;
begin
  foreach t in array array[
    'tax_deduction_section','tax_deduction','financial_year','opening_balance','gstr2b_line'
  ] loop
    execute format('grant select, insert, update, delete on %I to link_erp_app', t);
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy tenant_isolation on %I using (tenant_id = current_setting(''app.tenant_id'', true)::uuid)'
      || ' with check (tenant_id = current_setting(''app.tenant_id'', true)::uuid)', t);
  end loop;
end $$;

grant select on v_gstr2b_reconciliation, v_tds_summary to link_erp_app;
