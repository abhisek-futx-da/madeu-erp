-- Registers: the reports an accountant opens before any other, and which this
-- system had no equivalent of. A trial balance and a P&L were derivable, but
-- nobody could answer "show me August's sales bill by bill", "what did we book
-- on the 14th", or "print this weaver's ledger for the quarter".
--
-- voucher, voucher_line and opening_balance carry no row-level security; every
-- reader of them states the tenant itself. Everything below does.

-- Sales register — the outward day book, one row per bill.
create or replace view v_sales_register as
select i.tenant_id, i.id as invoice_id, i.invoice_no, i.invoice_date,
       p.code as party_code, p.name as party, p.gstin as party_gstin,
       i.place_of_supply, i.supply_type::text as supply_type,
       i.taxable_value, i.cgst_amount, i.sgst_amount, i.igst_amount,
       i.cgst_amount + i.sgst_amount + i.igst_amount as tax_amount,
       i.round_off, i.invoice_total,
       i.status::text as status, g.irn, v.voucher_no
  from sales_invoice i
  join ledger_account p on p.id = i.party_id
  left join voucher v on v.id = i.voucher_id
  left join gst_document g on g.voucher_id = i.voucher_id
 where is_live(i.status)
   and i.tenant_id = current_setting('app.tenant_id', true)::uuid;

-- Purchase register — the inward day book, one row per supplier bill.
create or replace view v_purchase_register as
select i.tenant_id, i.id as invoice_id, i.our_ref, i.supplier_invoice_no,
       i.invoice_date, p.code as party_code, p.name as party, p.gstin as party_gstin,
       i.place_of_supply, i.supply_type::text as supply_type, i.is_rcm,
       i.taxable_value, i.cgst_amount, i.sgst_amount, i.igst_amount,
       i.cgst_amount + i.sgst_amount + i.igst_amount as tax_amount,
       i.round_off, i.invoice_total, i.itc_eligible,
       i.status::text as status, v.voucher_no
  from purchase_invoice i
  join ledger_account p on p.id = i.party_id
  left join voucher v on v.id = i.voucher_id
 where is_live(i.status)
   and i.tenant_id = current_setting('app.tenant_id', true)::uuid;

-- Day book — every posted entry, both legs, in the order they were booked.
create or replace view v_day_book as
select vl.tenant_id, v.voucher_date, v.voucher_type::text as voucher_type,
       v.voucher_no, la.code as ledger_code, la.name as ledger,
       ca.name as control_account, ca.nature::text as nature,
       vl.debit, vl.credit, v.narration, v.source_doc
  from voucher_line vl
  join voucher v on v.id = vl.voucher_id and v.is_posted
  join ledger_account la on la.id = vl.ledger_id
  join control_account ca on ca.id = la.control_account_id
 where vl.tenant_id = current_setting('app.tenant_id', true)::uuid;

/**
 * The same numbers by head rather than by ledger, read off the trial balance
 * itself so the two can never disagree.
 *
 * v_trial_balance is left exactly as 042 defines it: a later migration that
 * reshapes an earlier one's view breaks the upgrade replay, which can apply
 * them out of order. The accounting head is reached by joining back on
 * (tenant_id, code) — unique on ledger_account — rather than on the control
 * account's name, which is not unique and would multiply rows into the totals.
 */
create or replace view v_trial_balance_grouped as
select tb.tenant_id, ca.nature::text as nature, ca.sub_control,
       ca.name              as control_account,
       count(*)::int        as ledgers,
       sum(tb.total_debit)  as total_debit,
       sum(tb.total_credit) as total_credit,
       sum(tb.balance)      as balance
  from v_trial_balance tb
  join ledger_account la on la.tenant_id = tb.tenant_id and la.code = tb.code
  join control_account ca on ca.id = la.control_account_id
 group by tb.tenant_id, ca.nature, ca.sub_control, ca.name;

/**
 * A ledger for a period, which a running balance over all time is not: the
 * opening carries everything before the window, so the closing figure is the
 * one the party will confirm. Row 0 is the opening balance.
 */
create or replace function report_ledger(p_ledger uuid, p_from date, p_to date)
returns table (
  seq int, voucher_date date, voucher_type text, voucher_no text,
  narration text, debit numeric, credit numeric, running_balance numeric
)
language sql stable as $$
  with fy as (
    select label, starts_on
      from financial_year
     where tenant_id = current_setting('app.tenant_id', true)::uuid
       and p_from between starts_on and ends_on
     limit 1
  ),
  opening as (
    select coalesce((select sum(ob.debit - ob.credit)
                       from opening_balance ob
                       join fy on fy.label = ob.fy_label
                      where ob.ledger_id = p_ledger
                        and ob.tenant_id = current_setting('app.tenant_id', true)::uuid), 0)
         + coalesce((select sum(vl.debit - vl.credit)
                       from voucher_line vl
                       join voucher v on v.id = vl.voucher_id and v.is_posted
                      where vl.ledger_id = p_ledger
                        and vl.tenant_id = current_setting('app.tenant_id', true)::uuid
                        -- No financial year covering the window opens everything.
                        and v.voucher_date >= coalesce((select starts_on from fy),
                                                       '-infinity'::date)
                        and v.voucher_date < p_from), 0) as amount
  ),
  ordered as (
    select row_number() over (order by v.voucher_date, v.voucher_no, vl.id)::int as seq,
           v.voucher_date, v.voucher_type::text as voucher_type, v.voucher_no,
           v.narration, vl.debit, vl.credit
      from voucher_line vl
      join voucher v on v.id = vl.voucher_id and v.is_posted
     where vl.ledger_id = p_ledger
       and vl.tenant_id = current_setting('app.tenant_id', true)::uuid
       and v.voucher_date between p_from and p_to
  )
  -- A union takes its output names from the first branch; the final ORDER BY
  -- resolves against those, so this branch names them.
  select 0 as seq, p_from as voucher_date, 'opening' as voucher_type,
         '' as voucher_no, 'Opening balance' as narration,
         greatest(o.amount, 0) as debit, greatest(-o.amount, 0) as credit,
         o.amount as running_balance
    from opening o
  union all
  select od.seq, od.voucher_date, od.voucher_type, od.voucher_no, od.narration,
         od.debit, od.credit,
         (select amount from opening)
           + sum(od.debit - od.credit) over (order by od.seq
                                             rows between unbounded preceding and current row)
    from ordered od
   order by seq;
$$;

comment on function report_ledger(uuid, date, date) is
  'One ledger over one period, opening balance first. Row 0 is the opening.';

grant select on v_sales_register, v_purchase_register, v_day_book,
                v_trial_balance_grouped to link_erp_app;
grant execute on function report_ledger(uuid, date, date) to link_erp_app;
