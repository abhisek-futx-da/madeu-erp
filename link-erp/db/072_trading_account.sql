-- The Trading Account, and the Profit & Loss split that follows from it.
--
-- An Indian accountant reads two statements, not one. The Trading Account
-- takes opening stock, purchases and direct costs against sales and closing
-- stock, and the balancing figure is Gross Profit. Only then does the P&L take
-- gross profit against indirect income and expenses to reach Net Profit.
--
-- The chart already carries the split — control_account.sub_control is
-- 'Direct Expenses', 'Direct Income', 'Indirect Expenses', 'Indirect Income'.
-- Nothing new is classified here; the statements finally read it.

/**
 * Income and expense for a period, keeping the direct/indirect split the
 * ledger has always had. report_profit_loss is left alone: it has callers,
 * and a function whose return type changes is a function that breaks them.
 */
create or replace function report_pl_sections(p_from date, p_to date)
returns table (
  section text, code text, name text, control_account text,
  sub_control text, amount numeric
) language sql stable as $$
  select case
           when ca.sub_control = 'Direct Income'    then 'trading_income'
           when ca.sub_control = 'Direct Expenses'  then 'trading_expense'
           when ca.nature = 'income'                then 'indirect_income'
           else 'indirect_expense'
         end as section,
         la.code, la.name, ca.name as control_account, ca.sub_control,
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
   group by ca.nature, ca.sub_control, la.code, la.name, ca.name
  having abs(sum(vl.debit - vl.credit)) > 0.005
   order by 1, 2
$$;

/**
 * What the stock accounts were worth on a date, and what moved through them
 * in a period.
 *
 * Grey and finish are taken as one block on purpose. Dyeing moves value from
 * grey to finish — a credit to one and a debit to the other — and across the
 * block those cancel, leaving debits that mean "came in from a supplier" and
 * credits that mean "left the mill". That is exactly what a Trading Account
 * calls purchases and cost of goods.
 */
create or replace function report_stock_movement(p_from date, p_to date)
returns table (opening numeric, purchases numeric, consumed numeric, closing numeric)
language sql stable as $$
  with stock as (
    select la.id from ledger_account la
     where la.posting_role in ('inventory_grey', 'inventory_finish')
       and la.tenant_id = current_setting('app.tenant_id', true)::uuid
  ),
  fy as (
    select label, starts_on from financial_year
     where tenant_id = current_setting('app.tenant_id', true)::uuid
       and p_from between starts_on and ends_on
     limit 1
  ),
  -- Opening carries the year's opening balance plus everything posted from
  -- the year start up to the day before the window.
  opening as (
    select coalesce((select sum(ob.debit - ob.credit) from opening_balance ob
                      join fy on fy.label = ob.fy_label
                     where ob.ledger_id in (select id from stock)
                       and ob.tenant_id = current_setting('app.tenant_id', true)::uuid), 0)
         + coalesce((select sum(vl.debit - vl.credit)
                       from voucher_line vl
                       join voucher v on v.id = vl.voucher_id and v.is_posted
                      where vl.ledger_id in (select id from stock)
                        and vl.tenant_id = current_setting('app.tenant_id', true)::uuid
                        and v.voucher_date >= coalesce((select starts_on from fy),
                                                       '-infinity'::date)
                        and v.voucher_date < p_from), 0) as amount
  ),
  moved as (
    select coalesce(sum(vl.debit), 0)  as debits,
           coalesce(sum(vl.credit), 0) as credits
      from voucher_line vl
      join voucher v on v.id = vl.voucher_id and v.is_posted
     where vl.ledger_id in (select id from stock)
       and vl.tenant_id = current_setting('app.tenant_id', true)::uuid
       and v.voucher_date between p_from and p_to
  )
  select round(o.amount, 2),
         round(m.debits, 2),
         round(m.credits, 2),
         round(o.amount + m.debits - m.credits, 2)
    from opening o, moved m
$$;

comment on function report_stock_movement(date, date) is
  'Opening, purchases in, goods consumed and closing across grey and finish stock.';

grant execute on function report_pl_sections(date, date) to link_erp_app;
grant execute on function report_stock_movement(date, date) to link_erp_app;
