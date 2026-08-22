-- The two statements every owner and every CA asks for first, and the numbers
-- an owner wants on screen at 9am. The system had a trial balance and nothing
-- above it.

-- ------------------------------------------------- correct the classifications --

-- Inventory was classified `capital`, which puts stock on the equity side of a
-- balance sheet. These repair a database seeded before 016 was corrected; on a
-- fresh build the seed is already right and both statements are no-ops.
update control_account set nature = 'current_asset'
 where nature = 'capital'
   and exists (select 1 from ledger_account la
                where la.control_account_id = control_account.id
                  and la.posting_role in ('inventory_grey', 'inventory_finish'));

-- Discount received shared a control account with discount allowed, so income
-- was being reported as an expense. It needs its own head, not a re-labelling.
insert into control_account (tenant_id, code, name, sub_control, nature)
select distinct la.tenant_id, '94', 'Discounts Received', 'Indirect Income',
       'income'::account_nature
  from ledger_account la where la.posting_role = 'discount_received'
on conflict (tenant_id, code) do nothing;

update ledger_account la set control_account_id = ca.id
  from control_account ca
 where ca.tenant_id = la.tenant_id and ca.code = '94'
   and la.posting_role = 'discount_received'
   and la.control_account_id <> ca.id;

/**
 * Where a ledger belongs on a statement. Natures that can legitimately fall on
 * either side — a tax account, a creditor holding an advance — are placed by
 * the sign of their balance, which is what a real balance sheet does.
 */
create or replace function statement_section(n account_nature, balance numeric)
returns text language sql immutable as $$
  select case
    when n = 'income'  then 'income'
    when n = 'expense' then 'expense'
    when n in ('cash', 'bank', 'current_asset', 'fixed_asset') then 'asset'
    when n = 'capital' then 'equity'
    when n in ('loan', 'current_liability') then 'liability'
    -- Debtors, creditors and tax accounts sit where their balance puts them.
    when balance > 0 then 'asset'
    else 'liability'
  end
$$;

-- ------------------------------------------------------------ profit & loss --

/**
 * Income and expense for a period. Income carries a credit balance, so it is
 * negated to read as a positive figure; `net_profit` is income less expense.
 */
create or replace function report_profit_loss(p_from date, p_to date)
returns table (
  section text, code text, name text, control_account text, amount numeric
) language sql stable as $$
  select case when ca.nature = 'income' then 'income' else 'expense' end as section,
         la.code, la.name, ca.name as control_account,
         round(case when ca.nature = 'income'
                    then sum(vl.credit - vl.debit)
                    else sum(vl.debit - vl.credit) end, 2) as amount
    from voucher_line vl
    join voucher v on v.id = vl.voucher_id and v.is_posted
    join ledger_account la on la.id = vl.ledger_id
    join control_account ca on ca.id = la.control_account_id
   where ca.nature in ('income', 'expense')
     and v.voucher_date between p_from and p_to
     and vl.tenant_id = current_setting('app.tenant_id', true)::uuid
   group by ca.nature, la.code, la.name, ca.name
  having abs(sum(vl.debit - vl.credit)) > 0.005
   order by 1 desc, 2
$$;

-- --------------------------------------------------------- balance sheet --

/**
 * Balances as on a date: the opening balance for the financial year plus every
 * posting since. The period's own profit is added to equity as its own line —
 * without it a mid-year sheet cannot balance, because the P&L accounts have
 * not yet been closed to retained earnings.
 */
create or replace function report_balance_sheet(p_as_on date)
returns table (
  section text, code text, name text, control_account text, amount numeric
) language sql stable as $$
  with fy as (
    select label, starts_on from financial_year
     where tenant_id = current_setting('app.tenant_id', true)::uuid
       and p_as_on between starts_on and ends_on
     limit 1
  ),
  movements as (
    select vl.ledger_id, sum(vl.debit - vl.credit) as bal
      from voucher_line vl
      join voucher v on v.id = vl.voucher_id and v.is_posted
     where vl.tenant_id = current_setting('app.tenant_id', true)::uuid
       and v.voucher_date <= p_as_on
       and v.voucher_date >= (select starts_on from fy)
     group by vl.ledger_id
  ),
  openings as (
    select ob.ledger_id, sum(ob.debit - ob.credit) as bal
      from opening_balance ob
     where ob.tenant_id = current_setting('app.tenant_id', true)::uuid
       and ob.fy_label = (select label from fy)
     group by ob.ledger_id
  ),
  combined as (
    select coalesce(m.ledger_id, o.ledger_id) as ledger_id,
           coalesce(m.bal, 0) + coalesce(o.bal, 0) as bal
      from movements m
      full outer join openings o on o.ledger_id = m.ledger_id
  ),
  lines as (
    select statement_section(ca.nature, c.bal) as section,
           la.code, la.name, ca.name as control_account,
           round(case when statement_section(ca.nature, c.bal) = 'asset'
                      then c.bal else -c.bal end, 2) as amount
      from combined c
      join ledger_account la on la.id = c.ledger_id
      join control_account ca on ca.id = la.control_account_id
     where ca.nature not in ('income', 'expense')
       and abs(c.bal) > 0.005
  ),
  period_result as (
    -- Income carries a credit balance and expense a debit one, so the net of
    -- (credit - debit) across both *is* the profit. Normalising each to a
    -- positive magnitude first and adding them would total them instead.
    select round(sum(vl.credit - vl.debit), 2) as profit
      from voucher_line vl
      join voucher v on v.id = vl.voucher_id and v.is_posted
      join ledger_account la on la.id = vl.ledger_id
      join control_account ca on ca.id = la.control_account_id
     where ca.nature in ('income', 'expense')
       and vl.tenant_id = current_setting('app.tenant_id', true)::uuid
       and v.voucher_date between (select starts_on from fy) and p_as_on
  )
  select * from lines
  union all
  select 'equity', '999',
         case when profit < 0 then 'Loss for the period' else 'Profit for the period' end,
         'Reserves & Surplus', profit
    from period_result where profit is not null and abs(profit) > 0.005
   order by 1, 2
$$;

-- ---------------------------------------------------------------- dashboard --

/**
 * One row of the numbers an owner opens the day with. Deliberately a single
 * query: the alternative is a screen firing a dozen requests on every load.
 */
create or replace function report_dashboard()
returns table (
  sales_today numeric, sales_mtd numeric, sales_ytd numeric,
  receivables numeric, receivables_overdue numeric,
  payables numeric,
  cash_and_bank numeric,
  stock_value numeric, stock_pieces bigint,
  pieces_at_dyeing bigint, qty_at_dyeing numeric,
  invoices_awaiting_irn bigint,
  challans_beyond_one_year bigint,
  overdue_orders bigint
) language sql stable as $$
  select
    (select coalesce(sum(taxable_value), 0) from sales_invoice
      where status <> 'cancelled' and invoice_date = current_date
        and tenant_id = current_setting('app.tenant_id', true)::uuid),
    (select coalesce(sum(taxable_value), 0) from sales_invoice
      where status <> 'cancelled' and invoice_date >= date_trunc('month', current_date)
        and tenant_id = current_setting('app.tenant_id', true)::uuid),
    (select coalesce(sum(taxable_value), 0) from sales_invoice
      where status <> 'cancelled'
        and invoice_date >= (case when extract(month from current_date) >= 4
              then make_date(extract(year from current_date)::int, 4, 1)
              else make_date(extract(year from current_date)::int - 1, 4, 1) end)
        and tenant_id = current_setting('app.tenant_id', true)::uuid),
    (select coalesce(sum(outstanding), 0) from v_outstanding_sales where outstanding > 0),
    (select coalesce(sum(outstanding), 0) from v_outstanding_sales
      where outstanding > 0 and overdue_days > 0),
    (select coalesce(sum(outstanding), 0) from v_outstanding_purchases where outstanding > 0),
    (select coalesce(sum(vl.debit - vl.credit), 0)
       from voucher_line vl
       join voucher v on v.id = vl.voucher_id and v.is_posted
       join ledger_account la on la.id = vl.ledger_id
       join control_account ca on ca.id = la.control_account_id
      where ca.nature in ('cash', 'bank')
        and vl.tenant_id = current_setting('app.tenant_id', true)::uuid),
    (select coalesce(sum(total_cost), 0) from v_stock_valuation),
    (select coalesce(sum(pcs), 0)::bigint from v_stock_valuation),
    (select count(*)::bigint from piece where status = 'issued_to_dyeing'
       and tenant_id = current_setting('app.tenant_id', true)::uuid),
    (select coalesce(sum(current_qty), 0) from piece where status = 'issued_to_dyeing'
       and tenant_id = current_setting('app.tenant_id', true)::uuid),
    (select count(*)::bigint from v_einvoice_pending),
    (select count(*)::bigint from v_itc04_pending where beyond_one_year),
    (select count(*)::bigint from v_po_pending where delay_days > 0)
$$;

/** Sales by month for the running financial year — the dashboard's one chart. */
create or replace view v_sales_trend as
select si.tenant_id,
       to_char(si.invoice_date, 'YYYY-MM') as month,
       sum(si.taxable_value) as taxable_value,
       sum(si.invoice_total) as invoice_total,
       count(*)::int as invoices
  from sales_invoice si
 where si.status <> 'cancelled'
   and si.invoice_date >= (case when extract(month from current_date) >= 4
         then make_date(extract(year from current_date)::int, 4, 1)
         else make_date(extract(year from current_date)::int - 1, 4, 1) end)
   and si.tenant_id = current_setting('app.tenant_id', true)::uuid
 group by si.tenant_id, to_char(si.invoice_date, 'YYYY-MM')
 order by 2;

/** The ten customers who owe the most — the other half of the dashboard. */
create or replace view v_top_debtors as
select tenant_id, party, code,
       sum(outstanding) as outstanding,
       sum(case when overdue_days > 0 then outstanding else 0 end) as overdue,
       max(overdue_days) as worst_overdue_days,
       count(*)::int as bills
  from v_outstanding_sales
 where outstanding > 0.005
 group by tenant_id, party, code
 order by 4 desc;

grant execute on function report_profit_loss(date, date), report_balance_sheet(date),
                         report_dashboard(), statement_section(account_nature, numeric)
  to link_erp_app;
grant select on v_sales_trend, v_top_debtors to link_erp_app;
