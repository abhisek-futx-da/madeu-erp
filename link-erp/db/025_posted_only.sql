-- "Not cancelled" used to mean "in the books", because cancelled was the only
-- way a document could fail to be one. Adding maker–checker put two more
-- statuses in the enum, and every money and tax view silently began counting
-- documents nobody had approved: a held invoice was appearing on GSTR-3B as a
-- declared outward supply, and in the receivable a customer had not been
-- billed for.
--
-- Caught by a test that compared the return against the posted invoices rather
-- than against the list.

create or replace function is_live(s doc_status) returns boolean
language sql immutable as $$
  select s in ('approved', 'partly_done', 'closed')
$$;

comment on function is_live(doc_status) is
  'True when a document is in the books: not draft, not held for approval, not rejected, not cancelled.';

create or replace view v_gstr1_b2b as
select i.tenant_id,
       to_char(i.invoice_date, 'MM-YYYY')      as return_period,
       p.gstin                                  as recipient_gstin,
       p.name                                   as recipient_name,
       i.invoice_no, i.invoice_date, i.invoice_total,
       i.place_of_supply, i.supply_type, i.is_rcm,
       l.gst_rate,
       sum(l.taxable_value) as taxable_value,
       sum(l.cgst_amount)   as cgst_amount,
       sum(l.sgst_amount)   as sgst_amount,
       sum(l.igst_amount)   as igst_amount
  from sales_invoice i
  join sales_invoice_line l on l.invoice_id = i.id
  join ledger_account p on p.id = i.party_id
 where is_live(i.status)
   and p.gstin is not null
   and i.tenant_id = current_setting('app.tenant_id', true)::uuid
 group by i.tenant_id, i.invoice_no, i.invoice_date, i.invoice_total,
          i.place_of_supply, i.supply_type, i.is_rcm, p.gstin, p.name, l.gst_rate;

create or replace view v_gstr1_hsn as
select i.tenant_id,
       to_char(i.invoice_date, 'MM-YYYY') as return_period,
       l.hsn_code, l.uom, l.gst_rate,
       sum(l.qty)            as total_qty,
       sum(l.taxable_value)  as taxable_value,
       sum(l.cgst_amount)    as cgst_amount,
       sum(l.sgst_amount)    as sgst_amount,
       sum(l.igst_amount)    as igst_amount
  from sales_invoice i
  join sales_invoice_line l on l.invoice_id = i.id
 where is_live(i.status)
   and i.tenant_id = current_setting('app.tenant_id', true)::uuid
 group by i.tenant_id, return_period, l.hsn_code, l.uom, l.gst_rate;

create or replace view v_gstr3b_outward as
select i.tenant_id,
       to_char(i.invoice_date, 'MM-YYYY') as return_period,
       sum(i.taxable_value) as taxable_value,
       sum(i.cgst_amount)   as cgst_amount,
       sum(i.sgst_amount)   as sgst_amount,
       sum(i.igst_amount)   as igst_amount,
       count(*)             as invoice_count
  from sales_invoice i
 where is_live(i.status)
   and i.tenant_id = current_setting('app.tenant_id', true)::uuid
 group by i.tenant_id, return_period;

create or replace view v_einvoice_pending as
select i.tenant_id, i.id as invoice_id, i.invoice_no, i.invoice_date,
       i.invoice_total, p.name as party_name, p.gstin,
       g.irn, g.filing_status, g.last_error
  from sales_invoice i
  join ledger_account p on p.id = i.party_id
  left join gst_document g on g.invoice_id = i.id
 where is_live(i.status)
   and (g.irn is null or g.filing_status <> 'accepted')
   and i.tenant_id = current_setting('app.tenant_id', true)::uuid;

create or replace view v_itc_summary as
select p.tenant_id,
       to_char(p.invoice_date, 'MM-YYYY') as return_period,
       p.itc_eligible,
       count(*)                as invoice_count,
       sum(p.taxable_value)    as taxable_value,
       sum(p.cgst_amount)      as cgst_credit,
       sum(p.sgst_amount)      as sgst_credit,
       sum(p.igst_amount)      as igst_credit
  from purchase_invoice p
 where is_live(p.status)
   and p.tenant_id = current_setting('app.tenant_id', true)::uuid
 group by p.tenant_id, return_period, p.itc_eligible;

create or replace view v_gst_liability as
with outward as (
  select to_char(invoice_date, 'MM-YYYY') as period,
         sum(cgst_amount) cgst, sum(sgst_amount) sgst, sum(igst_amount) igst
    from sales_invoice
   where is_live(status)
     and tenant_id = current_setting('app.tenant_id', true)::uuid
   group by 1
), inward as (
  select to_char(invoice_date, 'MM-YYYY') as period,
         sum(cgst_amount) cgst, sum(sgst_amount) sgst, sum(igst_amount) igst
    from purchase_invoice
   where is_live(status) and itc_eligible
     and tenant_id = current_setting('app.tenant_id', true)::uuid
   group by 1
), notes as (
  select to_char(note_date, 'MM-YYYY') as period,
         sum(case when note_kind = 'credit' then -cgst_amount else cgst_amount end) cgst,
         sum(case when note_kind = 'credit' then -sgst_amount else sgst_amount end) sgst,
         sum(case when note_kind = 'credit' then -igst_amount else igst_amount end) igst
    from gst_note
   where tenant_id = current_setting('app.tenant_id', true)::uuid
   group by 1
)
select coalesce(o.period, i.period, n.period) as return_period,
       coalesce(o.cgst,0) + coalesce(n.cgst,0) as output_cgst,
       coalesce(o.sgst,0) + coalesce(n.sgst,0) as output_sgst,
       coalesce(o.igst,0) + coalesce(n.igst,0) as output_igst,
       coalesce(i.cgst,0) as credit_cgst,
       coalesce(i.sgst,0) as credit_sgst,
       coalesce(i.igst,0) as credit_igst,
       coalesce(o.cgst,0) + coalesce(n.cgst,0) - coalesce(i.cgst,0) as net_cgst,
       coalesce(o.sgst,0) + coalesce(n.sgst,0) - coalesce(i.sgst,0) as net_sgst,
       coalesce(o.igst,0) + coalesce(n.igst,0) - coalesce(i.igst,0) as net_igst
  from outward o
  full join inward i on i.period = o.period
  full join notes  n on n.period = coalesce(o.period, i.period);

create or replace view v_receivable_ageing as
select i.tenant_id, p.code, p.name as party, i.invoice_no, i.invoice_date,
       i.invoice_total,
       coalesce(p.credit_days, 0) as credit_days,
       -- A future-dated invoice has no age; never report a negative one.
       greatest(0, current_date - i.invoice_date) as age_days,
       greatest(0, (current_date - i.invoice_date) - coalesce(p.credit_days, 0)) as overdue_days,
       case
         when greatest(0, current_date - i.invoice_date) <= 30  then '0-30'
         when greatest(0, current_date - i.invoice_date) <= 60  then '31-60'
         when greatest(0, current_date - i.invoice_date) <= 90  then '61-90'
         when greatest(0, current_date - i.invoice_date) <= 180 then '91-180'
         else '180+'
       end as bucket
  from sales_invoice i
  join ledger_account p on p.id = i.party_id
 where is_live(i.status)
   and i.tenant_id = current_setting('app.tenant_id', true)::uuid;

create or replace view v_quality_margin as
with sold as (
  select sl.tenant_id, q.id as quality_id, q.name as quality,
         sum(sl.qty) as qty_sold, sum(sl.taxable_value) as revenue
    from sales_invoice_line sl
    join sales_invoice si on si.id = sl.invoice_id and is_live(si.status)
    join quality q on q.id = sl.quality_id
   where sl.tenant_id = current_setting('app.tenant_id', true)::uuid
   group by sl.tenant_id, q.id, q.name
), grey_cost as (
  select il.tenant_id, p.quality_id, sum(il.amount) as grey_value
    from grey_inward_line il
    join piece p on p.id = il.piece_id
   where il.tenant_id = current_setting('app.tenant_id', true)::uuid
   group by il.tenant_id, p.quality_id
), job_cost as (
  select rl.tenant_id, p.quality_id, sum(rl.job_amount) as job_value
    from dyeing_receipt_line rl
    join piece p on p.id = rl.piece_id
   where rl.tenant_id = current_setting('app.tenant_id', true)::uuid
   group by rl.tenant_id, p.quality_id
)
select s.tenant_id, s.quality, s.qty_sold, s.revenue,
       coalesce(g.grey_value, 0) as grey_cost,
       coalesce(j.job_value, 0)  as jobwork_cost,
       s.revenue - coalesce(g.grey_value, 0) - coalesce(j.job_value, 0) as margin,
       round((s.revenue - coalesce(g.grey_value, 0) - coalesce(j.job_value, 0))
             * 100 / nullif(s.revenue, 0), 2) as margin_pct
  from sold s
  left join grey_cost g on g.quality_id = s.quality_id and g.tenant_id = s.tenant_id
  left join job_cost  j on j.quality_id = s.quality_id and j.tenant_id = s.tenant_id;

create or replace view v_gstr2b_reconciliation as
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
   where is_live(pi.status) and la.gstin is not null
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

create or replace view v_outstanding_sales as
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
 where is_live(i.status)
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
     where al.purchase_invoice_id = pi.id
  ) a on true
 where is_live(pi.status)
   and pi.tenant_id = current_setting('app.tenant_id', true)::uuid;

create or replace view v_cash_book as
select p.tenant_id, p.payment_date, p.voucher_no, p.kind, p.mode,
       l.name as party, b.name as bank_or_cash,
       case when p.kind = 'receipt' then p.amount else 0 end as inflow,
       case when p.kind = 'payment' then p.amount else 0 end as outflow,
       p.instrument_no, p.reconciled_at, p.narration
  from payment p
  join ledger_account l on l.id = p.party_id
  left join ledger_account b on b.id = p.bank_ledger_id
 where is_live(p.status)
   and p.tenant_id = current_setting('app.tenant_id', true)::uuid;

-- An allocation from a payment nobody has approved settles nothing.
create or replace function allocation_within_invoice() returns trigger as $$
declare
  ceiling   numeric(14,2);
  allocated numeric(14,2);
  label     text;
begin
  if new.sales_invoice_id is not null then
    select i.invoice_total
           - coalesce((select sum(case when n.note_kind = 'credit'
                                       then n.note_total else -n.note_total end)
                         from gst_note n where n.against_invoice_id = i.id), 0),
           i.invoice_no
      into ceiling, label
      from sales_invoice i where i.id = new.sales_invoice_id;

    select coalesce(sum(a.amount), 0) into allocated
      from payment_allocation a
      join payment p on p.id = a.payment_id and is_live(p.status)
     where a.sales_invoice_id = new.sales_invoice_id;
  else
    select pi.invoice_total, pi.our_ref into ceiling, label
      from purchase_invoice pi where pi.id = new.purchase_invoice_id;

    select coalesce(sum(a.amount), 0) into allocated
      from payment_allocation a
      join payment p on p.id = a.payment_id and is_live(p.status)
     where a.purchase_invoice_id = new.purchase_invoice_id;
  end if;

  if allocated > ceiling + 0.005 then
    raise exception 'allocations (%) exceed % which is collectable for %',
      allocated, ceiling, coalesce(label, 'that invoice');
  end if;
  return null;
end $$ language plpgsql;

grant execute on function is_live(doc_status) to link_erp_app;
grant select on v_gstr1_b2b, v_gstr1_hsn, v_gstr3b_outward, v_einvoice_pending,
                v_itc_summary, v_gst_liability, v_receivable_ageing, v_quality_margin,
                v_gstr2b_reconciliation, v_outstanding_sales, v_outstanding_purchases,
                v_cash_book
  to link_erp_app;
