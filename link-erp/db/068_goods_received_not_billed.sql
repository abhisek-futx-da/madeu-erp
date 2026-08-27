-- Goods and services received but not yet billed.
--
-- Two independent paths credited the supplier for the same delivery: taking
-- grey into stock (Dr Grey Stock / Cr Weaver) and then booking his bill
-- (Dr Trading Purchase / Cr Weaver). One 1,000 mtr delivery at 30.50 credited
-- the weaver 62,525 against goods worth 32,025 inclusive of GST, and the cost
-- sat in an asset and in Direct Expenses at once. The trial balance still
-- balanced because both sides doubled, which is exactly why nothing caught it.
--
-- The same fault ran through job work: a dyeing receipt credited the process
-- house for the processing, and the process house's bill credited it again.
--
-- The receipt now accrues to a clearing liability; the bill clears it and
-- credits the supplier. Stock is valued the day it arrives, and a supplier's
-- ledger shows only what he has actually billed.

alter type posting_role add value if not exists 'grey_not_billed';
alter type posting_role add value if not exists 'jobwork_not_billed';

-- ------------------------------------------------------------- the ledgers --

insert into control_account (tenant_id, code, name, sub_control, nature)
select id, '11', 'Received Not Billed', 'Current Liabilities', 'current_liability'
  from tenant
 on conflict (tenant_id, code) do nothing;

insert into ledger_account (tenant_id, code, name, control_account_id, gst_reg_type)
select t.id, x.code, x.name, c.id, 'unregistered'
  from tenant t
  join (values
    ('991', 'Grey Received — Not Yet Billed'),
    ('992', 'Job Work Done — Not Yet Billed')
  ) as x(code, name) on true
  join control_account c on c.tenant_id = t.id and c.code = '11'
 on conflict (tenant_id, code) do nothing;

update ledger_account l set posting_role = x.role::posting_role
  from (values ('991', 'grey_not_billed'), ('992', 'jobwork_not_billed')) as x(code, role)
 where l.code = x.code
   and l.posting_role is distinct from x.role::posting_role;

do $$
begin
  if exists (
    select 1 from tenant t
     where (select count(*) from ledger_account l
             where l.tenant_id = t.id
               and l.posting_role in ('grey_not_billed', 'jobwork_not_billed')) <> 2
  ) then
    raise exception 'every tenant needs both received-not-billed ledgers before postings move';
  end if;
end $$;

/**
 * Party-wise detail behind the two clearing balances.
 *
 * The clearing ledgers are control totals with no party dimension, so the
 * sub-ledger is derived from the documents themselves: what a supplier has
 * delivered, less what he has billed against those deliveries. This is the
 * number an owner wants weekly — goods in the godown nobody has invoiced yet.
 */
create or replace view v_unbilled_receipts as
with received as (
  select gi.tenant_id, gi.party_id, 'grey'::text as kind,
         gi.id as doc_id, gi.entry_no, gi.entry_date,
         gi.challan_no,
         -- amount and job_amount are the stored generated columns the
         -- postings themselves are built from; recomputing them here would
         -- let the report and the ledger drift apart.
         coalesce(sum(gil.amount), 0) as value
    from grey_inward gi
    join grey_inward_line gil on gil.inward_id = gi.id
   where is_live(gi.status)
   group by gi.tenant_id, gi.party_id, gi.id, gi.entry_no, gi.entry_date, gi.challan_no
  union all
  select dr.tenant_id, dr.process_house_id, 'jobwork',
         dr.id, dr.entry_no, dr.entry_date, dr.challan_no,
         coalesce(sum(drl.job_amount), 0)
    from dyeing_receipt dr
    join dyeing_receipt_line drl on drl.receipt_id = dr.id and drl.active
   where is_live(dr.status)
   group by dr.tenant_id, dr.process_house_id, dr.id, dr.entry_no, dr.entry_date, dr.challan_no
)
select r.tenant_id, r.kind, r.doc_id, r.entry_no, r.entry_date, r.challan_no,
       r.party_id, l.code as party_code, l.name as party,
       r.value                                   as received_value,
       coalesce(b.billed, 0)                     as billed_value,
       r.value - coalesce(b.billed, 0)           as unbilled_value,
       current_date - r.entry_date               as age_days
  from received r
  join ledger_account l on l.id = r.party_id
  left join lateral (
    select sum(pi.taxable_value) as billed
      from purchase_invoice pi
     where pi.source_id = r.doc_id
       and is_live(pi.status)
  ) b on true
 where r.value - coalesce(b.billed, 0) > 0.005
   and r.tenant_id = current_setting('app.tenant_id', true)::uuid;

/**
 * Books written before this migration carry the doubled postings. They are
 * posted vouchers and are deliberately not rewritten — a posted document is
 * reversed, never silently edited. This lists what to take to the accountant:
 * every bill that duplicates a receipt it was raised against.
 */
create or replace view v_double_booked_purchases as
select pi.tenant_id, pi.id as invoice_id, pi.our_ref, pi.supplier_invoice_no,
       pi.invoice_date, l.name as party, pi.source_doc, pi.source_id,
       pi.taxable_value as billed_twice_value, v.voucher_no
  from purchase_invoice pi
  join ledger_account l on l.id = pi.party_id
  left join voucher v on v.id = pi.voucher_id
 where is_live(pi.status)
   and pi.source_doc in ('grey_inward', 'dyeing_receipt')
   and pi.source_id is not null
   -- Only vouchers raised before the clearing accounts existed are affected.
   and pi.created_at < (select coalesce(min(applied_at), now())
                          from schema_migration
                         where filename = '068_goods_received_not_billed.sql')
   and pi.tenant_id = current_setting('app.tenant_id', true)::uuid;

grant select on v_unbilled_receipts, v_double_booked_purchases to link_erp_app;
