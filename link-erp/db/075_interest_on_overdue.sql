-- Interest on overdue bills — vyaj.
--
-- A buyer who takes ninety days on thirty-day terms has borrowed money from
-- the mill, and every trader in this market charges for it. The system could
-- age a bill and could not put a number on what the delay cost, so the
-- conversation happened on paper or not at all.
--
-- Nothing is posted from this. Interest becomes real when a debit note is
-- raised for it and the party accepts the charge; until then it is a claim,
-- and a claim in the books before it is agreed is a receivable that will
-- never be collected.

alter table ledger_account
  add column if not exists interest_rate_pct numeric(5,2) not null default 0;

alter table ledger_account drop constraint if exists ledger_interest_sane;
alter table ledger_account add constraint ledger_interest_sane
  check (interest_rate_pct >= 0 and interest_rate_pct <= 60);

comment on column ledger_account.interest_rate_pct is
  'Annual rate charged on bills paid past their credit days. 0 means none.';

/**
 * The mill-wide default, for parties with no rate of their own. Zero means
 * the mill does not charge interest, which is the honest starting point:
 * inventing a rate nobody agreed would put fictional income in a report.
 */
insert into tenant_setting (tenant_id, key, value)
select id, 'interest.default_annual_pct', '0'::jsonb from tenant
 on conflict (tenant_id, key) do nothing;

insert into tenant_setting (tenant_id, key, value)
select id, 'interest.grace_days', '0'::jsonb from tenant
 on conflict (tenant_id, key) do nothing;

/**
 * Interest on what a customer still owes, as on a date.
 *
 * Simple interest on the outstanding amount for the days it has run past the
 * credit period, at the party's own rate or the mill's default. Days are
 * counted from the due date, never from the invoice date — the credit period
 * was agreed and is not a delay.
 */
create or replace function report_interest_receivable(p_as_on date)
returns table (
  party_code text, party text, invoice_no text, invoice_date date,
  due_date date, outstanding numeric, rate_pct numeric,
  overdue_days integer, interest numeric
) language sql stable as $$
  with settings as (
    select coalesce((select (value #>> '{}')::numeric from tenant_setting
                      where tenant_id = current_setting('app.tenant_id', true)::uuid
                        and key = 'interest.default_annual_pct'), 0) as default_pct,
           coalesce((select (value #>> '{}')::int from tenant_setting
                      where tenant_id = current_setting('app.tenant_id', true)::uuid
                        and key = 'interest.grace_days'), 0) as grace
  )
  select o.code, o.party, o.invoice_no, o.invoice_date,
         (o.invoice_date + coalesce(o.credit_days, 0))::date as due_date,
         round(o.outstanding, 2),
         case when l.interest_rate_pct > 0 then l.interest_rate_pct
              else s.default_pct end as rate_pct,
         days.overdue,
         round(o.outstanding
               * (case when l.interest_rate_pct > 0 then l.interest_rate_pct
                       else s.default_pct end) / 100
               * days.overdue / 365.0, 2) as interest
    from v_outstanding_sales o
    join ledger_account l on l.id = o.party_id
    cross join settings s
    cross join lateral (
      select greatest(0,
        p_as_on - (o.invoice_date + coalesce(o.credit_days, 0))::date - s.grace)::int as overdue
    ) days
   where o.outstanding > 0.005
     and days.overdue > 0
     and (case when l.interest_rate_pct > 0 then l.interest_rate_pct
               else s.default_pct end) > 0
     and o.tenant_id = current_setting('app.tenant_id', true)::uuid
   order by o.party, o.invoice_date
$$;

comment on function report_interest_receivable(date) is
  'Simple interest on overdue receivables. A claim, not a posting.';

grant execute on function report_interest_receivable(date) to link_erp_app;

-- The same figures as a view, so the report registry can filter and total it
-- like every other report. As on today; the function takes any date.
create or replace view v_interest_receivable as
select current_setting('app.tenant_id', true)::uuid as tenant_id, *
  from report_interest_receivable(current_date);

grant select on v_interest_receivable to link_erp_app;
