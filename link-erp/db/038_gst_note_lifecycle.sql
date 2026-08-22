-- A GST note is a statutory document, not a disposable calculation row.  It
-- needs a document status, a traceable source when it came from a customer
-- return, and the same filed-period protection as a tax invoice.

alter table gst_note
  add column if not exists status doc_status not null default 'approved',
  add column if not exists source_doc text,
  add column if not exists source_id uuid;

update gst_note n
   set source_doc = 'customer_return', source_id = cr.id
  from customer_return cr
 where n.voucher_id = cr.voucher_id
   and n.source_doc is null;

create index if not exists gst_note_live_source_idx
  on gst_note (tenant_id, source_doc, source_id)
  where status <> 'cancelled';

create or replace function gst_note_period_is_open() returns trigger as $$
declare period text;
begin
  period := to_char(coalesce(new.note_date, old.note_date), 'MM-YYYY');
  if exists (
    select 1 from gst_filing f
     where f.tenant_id = coalesce(new.tenant_id, old.tenant_id)
       and f.return_type in ('GSTR1', 'GSTR3B')
       and f.return_period = period
  ) then
    raise exception 'GST return for % is already filed; do not alter this note', period;
  end if;
  return new;
end $$ language plpgsql;

drop trigger if exists gst_note_period_open on gst_note;
create trigger gst_note_period_open
  before insert on gst_note
  for each row execute function gst_note_period_is_open();

drop trigger if exists gst_note_no_retro_cancel on gst_note;
create trigger gst_note_no_retro_cancel
  before update of status on gst_note
  for each row when (new.status = 'cancelled' and old.status <> 'cancelled')
  execute function gst_note_period_is_open();

-- GSTR-1 CDNRA: registered-recipient credit/debit notes.  It is kept separate
-- from B2B invoices because the portal treats notes as their own section.
create or replace view v_gstr1_cdnr as
select n.tenant_id,
       to_char(n.note_date, 'MM-YYYY') as return_period,
       n.note_no, n.note_kind, n.note_date,
       i.invoice_no as against_invoice, i.invoice_date as against_invoice_date,
       p.gstin as recipient_gstin, p.name as recipient_name,
       n.place_of_supply, n.supply_type,
       n.taxable_value, n.cgst_amount, n.sgst_amount, n.igst_amount, n.note_total
  from gst_note n
  join sales_invoice i on i.id = n.against_invoice_id
  join ledger_account p on p.id = n.party_id
 where is_live(n.status)
   and p.gstin is not null
   and n.tenant_id = current_setting('app.tenant_id', true)::uuid;

-- GSTR-3B is net of approved credit/debit notes.  The previous view showed
-- gross invoice tax only, despite the liability view correctly recognising a
-- credit note; that disagreement is unacceptable in a CA review.
create or replace view v_gstr3b_outward as
with invoices as (
  select tenant_id, to_char(invoice_date, 'MM-YYYY') as return_period,
         sum(taxable_value) as taxable_value,
         sum(cgst_amount) as cgst_amount,
         sum(sgst_amount) as sgst_amount,
         sum(igst_amount) as igst_amount,
         count(*) as invoice_count
    from sales_invoice
   where is_live(status)
     and tenant_id = current_setting('app.tenant_id', true)::uuid
   group by tenant_id, to_char(invoice_date, 'MM-YYYY')
), notes as (
  select tenant_id, to_char(note_date, 'MM-YYYY') as return_period,
         sum(case when note_kind = 'credit' then -taxable_value else taxable_value end) as taxable_value,
         sum(case when note_kind = 'credit' then -cgst_amount else cgst_amount end) as cgst_amount,
         sum(case when note_kind = 'credit' then -sgst_amount else sgst_amount end) as sgst_amount,
         sum(case when note_kind = 'credit' then -igst_amount else igst_amount end) as igst_amount,
         count(*) filter (where note_kind = 'credit')::int as credit_note_count,
         count(*) filter (where note_kind = 'debit')::int as debit_note_count
    from gst_note
   where is_live(status)
     and tenant_id = current_setting('app.tenant_id', true)::uuid
   group by tenant_id, to_char(note_date, 'MM-YYYY')
)
select coalesce(i.tenant_id, n.tenant_id) as tenant_id,
       coalesce(i.return_period, n.return_period) as return_period,
       coalesce(i.taxable_value, 0) + coalesce(n.taxable_value, 0) as taxable_value,
       coalesce(i.cgst_amount, 0) + coalesce(n.cgst_amount, 0) as cgst_amount,
       coalesce(i.sgst_amount, 0) + coalesce(n.sgst_amount, 0) as sgst_amount,
       coalesce(i.igst_amount, 0) + coalesce(n.igst_amount, 0) as igst_amount,
       coalesce(i.invoice_count, 0) as invoice_count,
       coalesce(n.credit_note_count, 0) as credit_note_count,
       coalesce(n.debit_note_count, 0) as debit_note_count
  from invoices i
  full join notes n on n.tenant_id = i.tenant_id and n.return_period = i.return_period;

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
   where is_live(status)
     and tenant_id = current_setting('app.tenant_id', true)::uuid
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

grant select on v_gstr1_cdnr, v_gstr3b_outward, v_gst_liability to link_erp_app;
