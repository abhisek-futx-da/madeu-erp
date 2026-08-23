-- A process house may return pieces across many challans and later send one
-- consolidated job-work bill.  Reconcile that bill to actual receipt lines;
-- never force FIFO or a one-challan/one-bill fiction.

create table process_house_bill (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenant(id) on delete cascade,
  process_house_id  uuid not null references ledger_account(id),
  supplier_bill_no  text not null,
  bill_date         date not null,
  period_from       date,
  period_to         date,
  billed_metres     numeric(14,2) not null,
  billed_amount     numeric(14,2) not null,
  remarks           text not null default '',
  status            doc_status not null default 'approved',
  created_at        timestamptz not null default now(),
  created_by        uuid references app_user(id),
  cancelled_at      timestamptz,
  cancelled_by      uuid references app_user(id),
  cancellation_reason text,
  unique (tenant_id, process_house_id, supplier_bill_no),
  constraint process_bill_positive check (billed_metres >= 0 and billed_amount >= 0),
  constraint process_bill_period_sane check (
    period_from is null or period_to is null or period_from <= period_to
  ),
  constraint process_bill_cancellation_sane check (
    (status = 'cancelled' and cancelled_at is not null and cancelled_by is not null
      and length(btrim(cancellation_reason)) >= 2)
    or
    (status <> 'cancelled' and cancelled_at is null and cancelled_by is null
      and cancellation_reason is null)
  )
);

create table process_house_bill_allocation (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenant(id) on delete cascade,
  bill_id             uuid not null references process_house_bill(id) on delete cascade,
  receipt_line_id     uuid not null references dyeing_receipt_line(id),
  allocated_metres    numeric(12,2) not null,
  allocated_amount    numeric(14,2) not null,
  unique (bill_id, receipt_line_id),
  constraint process_allocation_positive check (
    allocated_metres > 0 and allocated_amount >= 0
  )
);

create index process_bill_by_house_date
  on process_house_bill(tenant_id, process_house_id, bill_date desc);
create index process_bill_by_cancelled_by
  on process_house_bill(cancelled_by) where cancelled_by is not null;
create index process_bill_allocation_by_receipt
  on process_house_bill_allocation(receipt_line_id);
create index process_bill_allocation_by_tenant
  on process_house_bill_allocation(tenant_id);

create or replace function validate_process_bill_allocation() returns trigger as $$
declare
  bill_house uuid;
  bill_tenant uuid;
  bill_metres numeric;
  bill_amount numeric;
  receipt_house uuid;
  receipt_tenant uuid;
  receipt_qty numeric;
  already_metres numeric;
  bill_allocated_metres numeric;
  bill_allocated_amount numeric;
begin
  select process_house_id,tenant_id,billed_metres,billed_amount
    into bill_house,bill_tenant,bill_metres,bill_amount
    from process_house_bill where id=new.bill_id and status<>'cancelled';
  select dr.process_house_id,rl.tenant_id,rl.received_qty
    into receipt_house,receipt_tenant,receipt_qty
    from dyeing_receipt_line rl join dyeing_receipt dr on dr.id=rl.receipt_id
   where rl.id=new.receipt_line_id and rl.active;
  if receipt_house is null then raise exception 'active dyeing receipt line not found'; end if;
  if bill_house is null then raise exception 'active process-house bill not found'; end if;
  if new.tenant_id<>bill_tenant or receipt_tenant<>bill_tenant then
    raise exception 'process-house bill allocation crosses tenants';
  end if;
  if bill_house <> receipt_house then
    raise exception 'receipt line belongs to a different process house';
  end if;
  select coalesce(sum(allocated_metres),0) into already_metres
    from process_house_bill_allocation a
    join process_house_bill b on b.id=a.bill_id and b.status<>'cancelled'
   where a.receipt_line_id=new.receipt_line_id and a.id<>new.id;
  if already_metres + new.allocated_metres > receipt_qty + 0.005 then
    raise exception 'allocated metres exceed the received metres';
  end if;
  select coalesce(sum(allocated_metres),0),coalesce(sum(allocated_amount),0)
    into bill_allocated_metres,bill_allocated_amount
    from process_house_bill_allocation where bill_id=new.bill_id and id<>new.id;
  if bill_allocated_metres+new.allocated_metres > bill_metres+0.005 then
    raise exception 'allocations exceed the bill metres';
  end if;
  if bill_allocated_amount+new.allocated_amount > bill_amount+0.005 then
    raise exception 'allocations exceed the bill amount';
  end if;
  return new;
end $$ language plpgsql;

create trigger process_bill_allocation_guard
before insert or update on process_house_bill_allocation
for each row execute function validate_process_bill_allocation();

create or replace view v_process_house_bill_reconciliation as
select b.tenant_id, b.id as bill_id, b.supplier_bill_no, b.bill_date,
       h.name as process_house, b.billed_metres, b.billed_amount,
       coalesce(sum(a.allocated_metres),0) as matched_metres,
       coalesce(sum(a.allocated_amount),0) as matched_amount,
       b.billed_metres-coalesce(sum(a.allocated_metres),0) as metre_difference,
       b.billed_amount-coalesce(sum(a.allocated_amount),0) as amount_difference,
       b.status, b.cancelled_at, b.cancelled_by, b.cancellation_reason
  from process_house_bill b
  join ledger_account h on h.id=b.process_house_id
  left join process_house_bill_allocation a on a.bill_id=b.id
 where b.tenant_id=current_setting('app.tenant_id', true)::uuid
 group by b.id,h.name;

alter table process_house_bill enable row level security;
alter table process_house_bill force row level security;
alter table process_house_bill_allocation enable row level security;
alter table process_house_bill_allocation force row level security;
create policy tenant_isolation on process_house_bill
  using (tenant_id=current_setting('app.tenant_id', true)::uuid)
  with check (tenant_id=current_setting('app.tenant_id', true)::uuid);
create policy tenant_isolation on process_house_bill_allocation
  using (tenant_id=current_setting('app.tenant_id', true)::uuid)
  with check (tenant_id=current_setting('app.tenant_id', true)::uuid);
grant select, insert, update, delete on process_house_bill,
  process_house_bill_allocation to link_erp_app;
grant select on v_process_house_bill_reconciliation to link_erp_app;
