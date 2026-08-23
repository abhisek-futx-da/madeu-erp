-- Textile settlements carry explicit commercial deductions.  A single
-- anonymous discount field cannot distinguish cash discount from a shade
-- claim, rate difference, shortage or TDS.  Record each reason and post it to
-- an unambiguous ledger.  Brokerage is accrued at invoice time but becomes a
-- broker payable only after the customer's bill is fully settled.

alter type posting_role add value if not exists 'quality_deduction';
alter type posting_role add value if not exists 'rate_difference';
alter type posting_role add value if not exists 'shortage_claim';
alter type posting_role add value if not exists 'brokerage_accrued';
alter type posting_role add value if not exists 'tds_payable';
alter type posting_role add value if not exists 'tds_receivable';

create type kapat_kind as enum (
  'cash_discount','quality_discount','rate_difference','shortage','tds','other'
);
create type kapat_tax_treatment as enum ('none','credit_note_required','debit_note_required');

insert into ledger_account
  (tenant_id, code, name, control_account_id, gst_reg_type, posting_role)
select t.id, x.code, x.name, c.id, 'unregistered', x.role::posting_role
  from tenant t
  join control_account c on c.tenant_id=t.id and c.code='93'
  cross join (values
    ('984','Quality / Shade Deductions','quality_deduction'),
    ('985','Rate Difference','rate_difference'),
    ('986','Shortage Claims','shortage_claim')
  ) x(code,name,role)
 where not exists (
   select 1 from ledger_account l
    where l.tenant_id=t.id and l.posting_role=x.role::posting_role
 )
on conflict (tenant_id, code) do nothing;

insert into control_account (tenant_id, code, name, sub_control, nature)
select id, '18', 'Current Tax Assets', 'Current Assets', 'current_asset'
  from tenant
on conflict (tenant_id, code) do nothing;

insert into ledger_account
  (tenant_id, code, name, control_account_id, gst_reg_type, posting_role)
select t.id, '988', 'TDS Receivable', c.id, 'unregistered', 'tds_receivable'
  from tenant t join control_account c on c.tenant_id=t.id and c.code='18'
 where not exists (
   select 1 from ledger_account l
    where l.tenant_id=t.id and l.posting_role='tds_receivable'
 )
on conflict (tenant_id, code) do nothing;

-- Older installations seeded code 940 under the output-GST sub-control.
-- It is still the TDS liability ledger, so move that known system code to the
-- general duties-and-taxes control while binding the semantic role.
update ledger_account l set posting_role='tds_payable', control_account_id=c.id
  from control_account c
 where l.tenant_id=c.tenant_id
   and l.code='940' and l.posting_role is null and c.code='80';

insert into ledger_account
  (tenant_id, code, name, control_account_id, gst_reg_type, posting_role)
select t.id, '940', 'TDS Payable', c.id, 'unregistered', 'tds_payable'
  from tenant t
  join control_account c on c.tenant_id=t.id and c.code='80'
 where not exists (
   select 1 from ledger_account l
    where l.tenant_id=t.id and l.posting_role='tds_payable'
 )
on conflict (tenant_id, code) do nothing;

insert into ledger_account
  (tenant_id, code, name, control_account_id, gst_reg_type, posting_role)
select t.id, '987', 'Brokerage Accrued — Not Yet Payable', c.id,
       'unregistered', 'brokerage_accrued'
  from tenant t
  join control_account c on c.tenant_id=t.id and c.code='10'
 where not exists (
   select 1 from ledger_account l
    where l.tenant_id=t.id and l.posting_role='brokerage_accrued'
 )
on conflict (tenant_id, code) do nothing;

do $$
begin
  if exists (
    select 1 from tenant t where not exists (
      select 1 from ledger_account l where l.tenant_id=t.id
       and l.posting_role in ('quality_deduction','rate_difference','shortage_claim',
                              'brokerage_accrued','tds_payable','tds_receivable')
      group by l.tenant_id having count(*) = 6
    )
  ) then
    raise exception 'one or more kapat/brokerage system ledger codes are occupied; bind all required posting roles before retrying';
  end if;
end $$;

create table payment_deduction (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenant(id) on delete cascade,
  payment_id          uuid not null references payment(id) on delete cascade,
  sales_invoice_id    uuid references sales_invoice(id),
  purchase_invoice_id uuid references purchase_invoice(id),
  kind                kapat_kind not null,
  amount              numeric(14,2) not null,
  reason              text not null,
  tax_treatment       kapat_tax_treatment not null default 'none',
  created_at          timestamptz not null default now(),
  constraint payment_deduction_positive check (amount > 0),
  constraint payment_deduction_reason check (length(btrim(reason)) >= 2),
  constraint payment_deduction_one_invoice check (
    (sales_invoice_id is not null)::int + (purchase_invoice_id is not null)::int = 1
  )
);
create index payment_deduction_by_payment on payment_deduction(payment_id);
create index payment_deduction_by_tenant on payment_deduction(tenant_id);
create index payment_deduction_by_sale on payment_deduction(sales_invoice_id)
  where sales_invoice_id is not null;
create index payment_deduction_by_purchase on payment_deduction(purchase_invoice_id)
  where purchase_invoice_id is not null;

create or replace function validate_payment_deduction() returns trigger as $$
declare
  p_tenant uuid;
  p_kind payment_kind;
  allocated numeric;
  deducted numeric;
begin
  select tenant_id,kind into p_tenant,p_kind from payment where id=new.payment_id;
  if new.tenant_id<>p_tenant then raise exception 'payment deduction crosses tenants'; end if;
  if (p_kind='receipt' and new.sales_invoice_id is null)
     or (p_kind='payment' and new.purchase_invoice_id is null) then
    raise exception 'deduction invoice type does not match payment kind';
  end if;
  select coalesce(sum(amount),0) into allocated from payment_allocation
   where payment_id=new.payment_id
     and sales_invoice_id is not distinct from new.sales_invoice_id
     and purchase_invoice_id is not distinct from new.purchase_invoice_id;
  if allocated=0 then raise exception 'deduction requires an allocation to the same invoice'; end if;
  select coalesce(sum(amount),0) into deducted from payment_deduction
   where payment_id=new.payment_id and id<>new.id
     and sales_invoice_id is not distinct from new.sales_invoice_id
     and purchase_invoice_id is not distinct from new.purchase_invoice_id;
  if deducted+new.amount > allocated+0.005 then
    raise exception 'deductions exceed the amount allocated to that invoice';
  end if;
  return new;
end $$ language plpgsql;

create trigger payment_deduction_guard before insert or update on payment_deduction
for each row execute function validate_payment_deduction();

alter table sales_invoice
  add column if not exists brokerage_state text not null default 'none',
  add column if not exists brokerage_released_on date,
  add column if not exists brokerage_release_voucher_id uuid references voucher(id),
  add column if not exists brokerage_release_payment_id uuid references payment(id),
  add column if not exists brokerage_forfeit_voucher_id uuid references voucher(id);

update sales_invoice set brokerage_state = 'released', brokerage_released_on = invoice_date
 where brokerage_amount > 0 and brokerage_state = 'none';

alter table sales_invoice drop constraint if exists brokerage_state_sane;
alter table sales_invoice add constraint brokerage_state_sane check (
  brokerage_state in ('none','accrued','released','forfeited')
  and (brokerage_amount > 0 or brokerage_state = 'none')
);

create index sales_invoice_brokerage_release_voucher
  on sales_invoice(brokerage_release_voucher_id) where brokerage_release_voucher_id is not null;
create index sales_invoice_brokerage_release_payment
  on sales_invoice(brokerage_release_payment_id) where brokerage_release_payment_id is not null;
create index sales_invoice_brokerage_forfeit_voucher
  on sales_invoice(brokerage_forfeit_voucher_id) where brokerage_forfeit_voucher_id is not null;

create or replace function allocation_matches_payment_party() returns trigger as $$
declare
  payment_tenant uuid;
  payment_party uuid;
  payment_kind payment_kind;
  invoice_tenant uuid;
  invoice_party uuid;
begin
  select tenant_id,party_id,kind into payment_tenant,payment_party,payment_kind
    from payment where id=new.payment_id;
  if new.sales_invoice_id is not null then
    select tenant_id,party_id into invoice_tenant,invoice_party
      from sales_invoice where id=new.sales_invoice_id and status<>'cancelled';
    if payment_kind<>'receipt' then raise exception 'sales invoices require a receipt'; end if;
  else
    select tenant_id,party_id into invoice_tenant,invoice_party
      from purchase_invoice where id=new.purchase_invoice_id and status<>'cancelled';
    if payment_kind<>'payment' then raise exception 'purchase invoices require a payment'; end if;
  end if;
  if invoice_tenant is null then raise exception 'live allocation invoice not found'; end if;
  if new.tenant_id<>payment_tenant or invoice_tenant<>payment_tenant then
    raise exception 'payment allocation crosses tenants';
  end if;
  if invoice_party<>payment_party then raise exception 'payment party does not own the allocated invoice'; end if;
  return new;
end $$ language plpgsql;

create trigger payment_allocation_party_guard before insert or update on payment_allocation
for each row execute function allocation_matches_payment_party();

-- Held or rejected payments are not money received and must not reduce ageing.
create or replace view v_outstanding_sales as
select i.tenant_id, i.id as invoice_id, i.invoice_no, i.invoice_date, i.created_at,
       p.code, p.name as party, p.credit_days,
       i.invoice_total,
       coalesce(a.paid, 0)                       as paid,
       coalesce(n.credited, 0)                   as credited,
       i.invoice_total - coalesce(a.paid, 0) - coalesce(n.credited, 0) as outstanding,
       greatest(0, current_date - i.invoice_date)                      as age_days,
       greatest(0, (current_date - i.invoice_date) - coalesce(p.credit_days, 0)) as overdue_days,
       i.party_id
  from sales_invoice i
  join ledger_account p on p.id = i.party_id
  left join lateral (
    select sum(al.amount) as paid from payment_allocation al
    join payment pay on pay.id=al.payment_id and pay.status='approved'
     where al.sales_invoice_id = i.id
  ) a on true
  left join lateral (
    select sum(case when gn.note_kind = 'credit' then gn.note_total else -gn.note_total end)
             as credited
      from gst_note gn where gn.against_invoice_id = i.id and gn.status <> 'cancelled'
  ) n on true
 where i.status <> 'cancelled'
   and i.tenant_id = current_setting('app.tenant_id', true)::uuid;

create or replace view v_outstanding_purchases as
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
    join payment pay on pay.id=al.payment_id and pay.status='approved'
     where al.purchase_invoice_id = pi.id
  ) a on true
 where pi.status <> 'cancelled'
   and pi.tenant_id = current_setting('app.tenant_id', true)::uuid;

alter table payment_deduction enable row level security;
alter table payment_deduction force row level security;
create policy tenant_isolation on payment_deduction
  using (tenant_id=current_setting('app.tenant_id', true)::uuid)
  with check (tenant_id=current_setting('app.tenant_id', true)::uuid);
grant select, insert, update, delete on payment_deduction to link_erp_app;
