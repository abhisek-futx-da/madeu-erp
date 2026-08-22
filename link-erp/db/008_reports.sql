-- Input credit, ageing, year-end and the analytics a mill actually decides on.
-- Every view filters on the session tenant itself; see the note in 001.

-- ------------------------------------------------------- input tax credit --

create view v_itc_summary as
select p.tenant_id,
       to_char(p.invoice_date, 'MM-YYYY') as return_period,
       p.itc_eligible,
       count(*)                as invoice_count,
       sum(p.taxable_value)    as taxable_value,
       sum(p.cgst_amount)      as cgst_credit,
       sum(p.sgst_amount)      as sgst_credit,
       sum(p.igst_amount)      as igst_credit
  from purchase_invoice p
 where p.status <> 'cancelled'
   and p.tenant_id = current_setting('app.tenant_id', true)::uuid
 group by p.tenant_id, return_period, p.itc_eligible;

-- GSTR-3B table 4: credit available, netted against output for the period.
create view v_gst_liability as
with outward as (
  select to_char(invoice_date, 'MM-YYYY') as period,
         sum(cgst_amount) cgst, sum(sgst_amount) sgst, sum(igst_amount) igst
    from sales_invoice
   where status <> 'cancelled'
     and tenant_id = current_setting('app.tenant_id', true)::uuid
   group by 1
), inward as (
  select to_char(invoice_date, 'MM-YYYY') as period,
         sum(cgst_amount) cgst, sum(sgst_amount) sgst, sum(igst_amount) igst
    from purchase_invoice
   where status <> 'cancelled' and itc_eligible
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

-- ----------------------------------------------------------------- ageing --

-- Outstanding by invoice, bucketed the way a collections call is actually made.
create view v_receivable_ageing as
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
 where i.status <> 'cancelled'
   and i.tenant_id = current_setting('app.tenant_id', true)::uuid;

create view v_party_statement as
select vl.tenant_id, la.code, la.name as party,
       v.voucher_date, v.voucher_type, v.voucher_no, v.narration,
       vl.debit, vl.credit,
       sum(vl.debit - vl.credit) over (
         partition by vl.ledger_id order by v.voucher_date, v.voucher_no, vl.id
       ) as running_balance
  from voucher_line vl
  join voucher v on v.id = vl.voucher_id and v.is_posted
  join ledger_account la on la.id = vl.ledger_id
 where vl.tenant_id = current_setting('app.tenant_id', true)::uuid;

-- Trial balance: the report a CA asks for first, and it must sum to zero.
create view v_trial_balance as
select vl.tenant_id, la.code, la.name, ca.name as control_account, ca.nature,
       sum(vl.debit)  as total_debit,
       sum(vl.credit) as total_credit,
       sum(vl.debit) - sum(vl.credit) as balance
  from voucher_line vl
  join voucher v on v.id = vl.voucher_id and v.is_posted
  join ledger_account la on la.id = vl.ledger_id
  join control_account ca on ca.id = la.control_account_id
 where vl.tenant_id = current_setting('app.tenant_id', true)::uuid
 group by vl.tenant_id, la.code, la.name, ca.name, ca.nature;

-- -------------------------------------------------------------- analytics --

-- What a quality actually earned: sale value less grey cost less jobwork.
create view v_quality_margin as
with sold as (
  select sl.tenant_id, q.id as quality_id, q.name as quality,
         sum(sl.qty) as qty_sold, sum(sl.taxable_value) as revenue
    from sales_invoice_line sl
    join sales_invoice si on si.id = sl.invoice_id and si.status <> 'cancelled'
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

-- Which weavers deliver on time and in full.
create view v_weaver_scorecard as
select o.tenant_id, l.code, l.name as weaver,
       count(distinct o.id)                                  as orders,
       sum(ol.qty)                                           as ordered_qty,
       sum(ol.received_qty)                                  as received_qty,
       round(sum(ol.received_qty) * 100 / nullif(sum(ol.qty), 0), 2) as fill_rate_pct,
       count(*) filter (
         where ol.received_qty < ol.qty and o.delivery_date < current_date
       )                                                     as late_lines
  from grey_purchase_order o
  join grey_purchase_order_line ol on ol.order_id = o.id
  join ledger_account l on l.id = o.party_id
 where o.tenant_id = current_setting('app.tenant_id', true)::uuid
 group by o.tenant_id, l.code, l.name;

-- Process-house scorecard: shrinkage plus how long they hold the goods.
create view v_process_house_scorecard as
select r.tenant_id, l.code, l.name as process_house,
       count(distinct r.id)          as receipts,
       count(rl.id)                  as pieces,
       sum(rl.issued_qty)            as issued_qty,
       sum(rl.received_qty)          as received_qty,
       round(sum(rl.shrinkage_qty) * 100 / nullif(sum(rl.issued_qty), 0), 3) as shrinkage_pct,
       round(avg(r.entry_date - di.entry_date), 1) as avg_turnaround_days
  from dyeing_receipt_line rl
  join dyeing_receipt r on r.id = rl.receipt_id
  join dyeing_issue_line il on il.id = rl.issue_line_id
  join dyeing_issue di on di.id = il.issue_id
  join ledger_account l on l.id = r.process_house_id
 where r.tenant_id = current_setting('app.tenant_id', true)::uuid
 group by r.tenant_id, l.code, l.name;

grant select on
  v_itc_summary, v_gst_liability, v_receivable_ageing, v_party_statement,
  v_trial_balance, v_quality_margin, v_weaver_scorecard, v_process_house_scorecard
  to link_erp_app;
