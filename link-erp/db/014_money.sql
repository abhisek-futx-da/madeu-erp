-- Payments, receipts and inventory valuation: the two gaps that stopped this
-- being an ERP. Before this, nobody could pay you and stock was worth nothing.

-- ------------------------------------------------------------ posting roles --

alter type posting_role add value if not exists 'inventory_grey';
alter type posting_role add value if not exists 'inventory_finish';
alter type posting_role add value if not exists 'cogs';
alter type posting_role add value if not exists 'cash';
alter type posting_role add value if not exists 'bank';
alter type posting_role add value if not exists 'discount_allowed';
alter type posting_role add value if not exists 'discount_received';

-- ------------------------------------------------------ payments & receipts --

create type payment_kind as enum ('receipt', 'payment');
create type payment_mode as enum ('cash', 'cheque', 'neft', 'rtgs', 'upi', 'adjustment');

create table bank_account (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  ledger_id     uuid not null references ledger_account(id),
  bank_name     text not null,
  account_no    text not null,
  ifsc          char(11),
  branch        text,
  is_default    boolean not null default false,
  unique (tenant_id, account_no),
  constraint ifsc_shape check (ifsc is null or ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$')
);
create unique index bank_one_default on bank_account (tenant_id) where is_default;

create table payment (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenant(id) on delete cascade,
  voucher_no      text not null,
  kind            payment_kind not null,
  payment_date    date not null,
  party_id        uuid not null references ledger_account(id),
  mode            payment_mode not null,
  instrument_no   text,
  instrument_date date,
  bank_ledger_id  uuid references ledger_account(id),
  amount          numeric(14,2) not null,
  discount        numeric(14,2) not null default 0,
  narration       text default '',
  voucher_id      uuid references voucher(id),
  status          doc_status not null default 'approved',
  reconciled_at   timestamptz,
  created_at      timestamptz not null default now(),
  created_by      uuid references app_user(id),
  unique (tenant_id, voucher_no),
  constraint payment_positive check (amount > 0 and discount >= 0),
  -- Anything that moves through a bank needs an account and an instrument.
  constraint payment_bank_details check (
    mode = 'cash' or mode = 'adjustment' or bank_ledger_id is not null
  )
);

create index payment_by_party on payment (tenant_id, party_id, payment_date);

-- Which invoices a payment settles. Unallocated payments are on account.
create table payment_allocation (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenant(id) on delete cascade,
  payment_id          uuid not null references payment(id) on delete cascade,
  sales_invoice_id    uuid references sales_invoice(id),
  purchase_invoice_id uuid references purchase_invoice(id),
  amount              numeric(14,2) not null,
  constraint allocation_positive check (amount > 0),
  -- Exactly one side; a receipt settles a sale, a payment settles a purchase.
  constraint allocation_one_target check (
    (sales_invoice_id is not null)::int + (purchase_invoice_id is not null)::int = 1
  )
);

create index allocation_by_sales on payment_allocation (sales_invoice_id)
  where sales_invoice_id is not null;
create index allocation_by_purchase on payment_allocation (purchase_invoice_id)
  where purchase_invoice_id is not null;

/** A payment can never allocate more than it is worth. */
create or replace function allocation_within_payment() returns trigger as $$
declare total numeric(14,2); paid numeric(14,2);
begin
  select amount + discount into paid from payment where id = new.payment_id;
  select coalesce(sum(amount), 0) into total
    from payment_allocation where payment_id = new.payment_id;
  if total > paid + 0.005 then
    raise exception 'allocations (%) exceed the payment (%)', total, paid;
  end if;
  return null;
end $$ language plpgsql;

create constraint trigger allocation_fits
  after insert or update on payment_allocation
  deferrable initially deferred
  for each row execute function allocation_within_payment();

-- ------------------------------------------------------------- valuation --

-- Cost follows the piece. Grey cost is known at inward; jobwork lands at
-- receipt; both together are what the piece is worth in stock.
alter table piece add column grey_cost      numeric(12,2) not null default 0;
alter table piece add column jobwork_cost   numeric(12,2) not null default 0;
alter table piece add column other_cost     numeric(12,2) not null default 0;
alter table piece add column cost_posted    boolean not null default false;

create view v_stock_valuation as
select p.tenant_id, p.status, q.name as quality, g.name as grade,
       count(*)                                          as pcs,
       sum(p.current_qty)                                as qty,
       sum(p.grey_cost)                                  as grey_cost,
       sum(p.jobwork_cost)                               as jobwork_cost,
       sum(p.grey_cost + p.jobwork_cost + p.other_cost)  as total_cost,
       round(sum(p.grey_cost + p.jobwork_cost + p.other_cost)
             / nullif(sum(p.current_qty), 0), 2)         as cost_per_mtr
  from piece p
  join quality q on q.id = p.quality_id
  join grade g on g.tenant_id = p.tenant_id and g.code = p.grade_code
 where p.status in ('grey_in_stock','issued_to_dyeing','received_finish','cut_packed')
   and p.tenant_id = current_setting('app.tenant_id', true)::uuid
 group by p.tenant_id, p.status, q.name, g.name;

-- What each party still owes, invoice by invoice, net of what they have paid.
create view v_outstanding_sales as
select i.tenant_id, i.id as invoice_id, i.invoice_no, i.invoice_date, i.created_at,
       p.code, p.name as party, p.credit_days,
       i.invoice_total,
       coalesce(a.paid, 0)                       as paid,
       coalesce(n.credited, 0)                   as credited,
       i.invoice_total - coalesce(a.paid, 0) - coalesce(n.credited, 0) as outstanding,
       greatest(0, current_date - i.invoice_date)                      as age_days,
       greatest(0, (current_date - i.invoice_date) - coalesce(p.credit_days, 0)) as overdue_days
  from sales_invoice i
  join ledger_account p on p.id = i.party_id
  left join lateral (
    select sum(al.amount) as paid from payment_allocation al
     where al.sales_invoice_id = i.id
  ) a on true
  left join lateral (
    select sum(case when gn.note_kind = 'credit' then gn.note_total else -gn.note_total end)
             as credited
      from gst_note gn where gn.against_invoice_id = i.id
  ) n on true
 where i.status <> 'cancelled'
   and i.tenant_id = current_setting('app.tenant_id', true)::uuid;

create view v_outstanding_purchases as
select pi.tenant_id, pi.id as invoice_id, pi.our_ref, pi.supplier_invoice_no,
       pi.invoice_date, pi.created_at, l.code, l.name as party,
       pi.invoice_total,
       coalesce(a.paid, 0) as paid,
       pi.invoice_total - coalesce(a.paid, 0) as outstanding,
       greatest(0, current_date - pi.invoice_date) as age_days
  from purchase_invoice pi
  join ledger_account l on l.id = pi.party_id
  left join lateral (
    select sum(al.amount) as paid from payment_allocation al
     where al.purchase_invoice_id = pi.id
  ) a on true
 where pi.status <> 'cancelled'
   and pi.tenant_id = current_setting('app.tenant_id', true)::uuid;

create view v_cash_book as
select p.tenant_id, p.payment_date, p.voucher_no, p.kind, p.mode,
       l.name as party, b.name as bank_or_cash,
       case when p.kind = 'receipt' then p.amount else 0 end as inflow,
       case when p.kind = 'payment' then p.amount else 0 end as outflow,
       p.instrument_no, p.reconciled_at, p.narration
  from payment p
  join ledger_account l on l.id = p.party_id
  left join ledger_account b on b.id = p.bank_ledger_id
 where p.status <> 'cancelled'
   and p.tenant_id = current_setting('app.tenant_id', true)::uuid;

-- --------------------------------------------------------- extra masters --

create table unit_master (
  tenant_id  uuid not null references tenant(id) on delete cascade,
  code       text not null,
  name       text not null,
  uqc        text not null,
  primary key (tenant_id, code)
);

create table width_master (
  tenant_id  uuid not null references tenant(id) on delete cascade,
  code       text not null,
  cms        numeric(6,2) not null,
  inches     numeric(6,2),
  primary key (tenant_id, code)
);

create table rack_master (
  tenant_id  uuid not null references tenant(id) on delete cascade,
  code       text not null,
  name       text not null,
  location   text default '',
  primary key (tenant_id, code)
);

-- Negotiated rates, so nobody retypes a price from memory.
create table rate_contract (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenant(id) on delete cascade,
  party_id     uuid not null references ledger_account(id) on delete cascade,
  quality_id   uuid references quality(id) on delete cascade,
  kind         text not null,
  rate         numeric(10,2) not null,
  valid_from   date not null,
  valid_to     date,
  constraint rate_kind check (kind in ('purchase', 'sales', 'jobwork')),
  constraint rate_positive check (rate >= 0),
  constraint rate_dates check (valid_to is null or valid_to >= valid_from)
);
create unique index rate_contract_scope on rate_contract
  (tenant_id, party_id, coalesce(quality_id, '00000000-0000-0000-0000-000000000000'::uuid),
   kind, valid_from);

-- ------------------------------------------------------------ privileges --

do $$
declare t text;
begin
  foreach t in array array[
    'bank_account','payment','payment_allocation',
    'unit_master','width_master','rack_master','rate_contract'
  ] loop
    execute format('grant select, insert, update, delete on %I to link_erp_app', t);
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy tenant_isolation on %I using (tenant_id = current_setting(''app.tenant_id'', true)::uuid)'
      || ' with check (tenant_id = current_setting(''app.tenant_id'', true)::uuid)', t);
  end loop;
end $$;

grant select on v_stock_valuation, v_outstanding_sales, v_outstanding_purchases, v_cash_book
  to link_erp_app;
