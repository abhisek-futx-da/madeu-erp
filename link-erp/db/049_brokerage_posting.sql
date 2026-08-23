-- Brokerage rules used to be configurable but had no effect on the books.
-- Preserve the resolved rule on each sales invoice and post its accrual in the
-- same voucher as the sale: debit brokerage expense, credit the broker.

alter type posting_role add value if not exists 'brokerage_expense';

-- Existing companies need a deterministic posting target before an already
-- configured rule can start affecting vouchers. These are neutral system
-- heads; the CA may rename them, but the posting role remains unambiguous.
insert into control_account (tenant_id, code, name, sub_control, nature)
select id, '98', 'Brokerage Expense', 'Indirect Expenses', 'expense'
  from tenant
on conflict (tenant_id, code) do nothing;

do $$
begin
  if exists (
    select 1 from tenant t
    join control_account c on c.tenant_id=t.id and c.code='98'
    where c.nature <> 'expense'
  ) then
    raise exception 'control account code 98 already exists with a non-expense nature; resolve it before brokerage migration';
  end if;
end $$;

-- A pre-049 demo/legacy seed may already have created the neutral ledger
-- without being able to name the not-yet-existing enum value.
update ledger_account l set posting_role='brokerage_expense'
  from control_account c
 where l.control_account_id=c.id
   and l.code='982' and l.posting_role is null and c.nature='expense';

insert into ledger_account
  (tenant_id, code, name, control_account_id, gst_reg_type, posting_role)
select t.id, '982', 'Brokerage Expense', c.id, 'unregistered', 'brokerage_expense'
  from tenant t
  join control_account c on c.tenant_id=t.id and c.code='98'
 where not exists (
   select 1 from ledger_account l
    where l.tenant_id=t.id and l.posting_role='brokerage_expense'
 )
on conflict (tenant_id, code) do nothing;

do $$
begin
  if exists (
    select 1 from tenant t where not exists (
      select 1 from ledger_account l
       where l.tenant_id=t.id and l.posting_role='brokerage_expense'
    )
  ) then
    raise exception 'ledger code 982 is occupied; bind one expense ledger to brokerage_expense before retrying';
  end if;
end $$;

alter table sales_invoice
  add column if not exists broker_id uuid references ledger_account(id),
  add column if not exists brokerage_rule_id uuid references brokerage_rule(id) on delete set null,
  add column if not exists brokerage_amount numeric(14,2) not null default 0;

alter table sales_invoice drop constraint if exists sales_invoice_brokerage_sane;
alter table sales_invoice add constraint sales_invoice_brokerage_sane check (
  brokerage_amount >= 0
  and (
    (brokerage_amount = 0 and broker_id is null and brokerage_rule_id is null)
    or
    (brokerage_amount > 0 and broker_id is not null and brokerage_rule_id is not null)
  )
);

create index if not exists sales_invoice_by_broker
  on sales_invoice (broker_id) where broker_id is not null;
create index if not exists sales_invoice_by_brokerage_rule
  on sales_invoice (brokerage_rule_id) where brokerage_rule_id is not null;
