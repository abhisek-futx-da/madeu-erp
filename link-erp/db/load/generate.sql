-- A year of a working mill, generated in bulk.
--
-- Every performance claim so far rested on a demo database of two thousand
-- pieces. A Bhiwandi trader moves that in a fortnight. This builds a year at
-- realistic scale so query plans are read against the volume they will meet,
-- not the volume that happened to be lying around.
--
--   psql -d linkerp_load -f generate.sql
--
-- Scale: 250 working days, ~60 pieces a day inward, ~1.5 lakh pieces, with the
-- movements, invoices and vouchers that follow.

\set ON_ERROR_STOP on
\timing on

set session_replication_role = 'replica';   -- triggers off; this is bulk load
set app.tenant_id = '11111111-1111-1111-1111-111111111111';

\echo '== pieces =='

insert into piece (tenant_id, business_location_id, barcode, quality_id, design_id, grade_code, lot_no,
                   status, held_by_ledger_id, grey_qty, finish_qty, current_qty,
                   grey_cost, jobwork_cost, created_at)
select '11111111-1111-1111-1111-111111111111',
       (select id from business_location
         where tenant_id='11111111-1111-1111-1111-111111111111' and is_default),
       'LOAD' || g,
       (array['44444444-0000-0000-0000-000000000001'::uuid,
              '44444444-0000-0000-0000-000000000002'::uuid])[1 + g % 2],
       null,
       (array['A','B','LUMP'])[1 + g % 3],
       'LOT' || (g / 60),
       -- The shape of a real floor: most sold, some in stock, some out dyeing.
       (case when g % 10 < 6 then 'dispatched'
             when g % 10 < 8 then 'grey_in_stock'
             when g % 10 < 9 then 'issued_to_dyeing'
             else 'received_finish' end)::piece_status,
       case when g % 10 = 8 then '33333333-0000-0000-0000-000000000202'::uuid else null end,
       100 + (g % 30),
       -- Anything that came back from dyeing has a finish quantity: the
       -- dispatched ones and the ones sitting as finish. Grey in stock and
       -- goods still out at the process house do not.
       case when g % 10 < 6 or g % 10 = 9 then 95 + (g % 25) else null end,
       case when g % 10 < 6 or g % 10 = 9 then 95 + (g % 25) else 100 + (g % 30) end,
       round((100 + (g % 30)) * 30.5, 2),
       case when g % 10 < 6 or g % 10 = 9 then round((95 + (g % 25)) * 18, 2) else 0 end,
       timestamptz '2026-04-01 09:00+05:30' + (g / 60) * interval '1 day'
  from generate_series(1, 150000) g;

\echo '== movements (one per piece per state it passed through) =='

insert into piece_movement (tenant_id, piece_id, event, from_status, to_status,
                            qty_before, qty_after, doc_type, doc_id, occurred_at, created_by)
select p.tenant_id, p.id, 'inward', null, 'grey_in_stock'::piece_status,
       0, p.grey_qty, 'grey_inward', gen_random_uuid(), p.created_at,
       'aaaaaaaa-0000-0000-0000-000000000001'
  from piece p where p.barcode like 'LOAD%';

insert into piece_movement (tenant_id, piece_id, event, from_status, to_status,
                            qty_before, qty_after, doc_type, doc_id, occurred_at, created_by)
select p.tenant_id, p.id, 'issue', 'grey_in_stock'::piece_status, 'issued_to_dyeing'::piece_status,
       p.grey_qty, p.grey_qty, 'dyeing_issue', gen_random_uuid(),
       p.created_at + interval '1 day', 'aaaaaaaa-0000-0000-0000-000000000001'
  from piece p
 where p.barcode like 'LOAD%'
   and p.status in ('issued_to_dyeing', 'received_finish', 'cut_packed', 'dispatched');

insert into piece_movement (tenant_id, piece_id, event, from_status, to_status,
                            qty_before, qty_after, doc_type, doc_id, occurred_at, created_by)
select p.tenant_id, p.id, 'receipt', 'issued_to_dyeing'::piece_status, 'received_finish'::piece_status,
       p.grey_qty, p.finish_qty, 'dyeing_receipt', gen_random_uuid(),
       p.created_at + interval '15 days', 'aaaaaaaa-0000-0000-0000-000000000001'
  from piece p
 where p.barcode like 'LOAD%' and p.status in ('received_finish', 'cut_packed', 'dispatched');

insert into piece_movement (tenant_id, piece_id, event, from_status, to_status,
                            qty_before, qty_after, doc_type, doc_id, occurred_at, created_by)
select p.tenant_id, p.id, 'dispatch', 'received_finish'::piece_status, 'dispatched'::piece_status,
       p.finish_qty, p.finish_qty, 'dispatch', gen_random_uuid(),
       p.created_at + interval '20 days', 'aaaaaaaa-0000-0000-0000-000000000001'
  from piece p where p.barcode like 'LOAD%' and p.status = 'dispatched';

\echo '== invoices: 250 days x ~12 a day =='

with priced as (
  select g,
         round((50000 + (g % 40000))::numeric, 2) as taxable,
         (g % 2 = 0) as inter_state
    from generate_series(1, 3000) g
), taxed as (
  select g, taxable, inter_state,
         case when inter_state then 0 else round(taxable * 0.025, 2) end as cgst,
         case when inter_state then 0 else round(taxable * 0.025, 2) end as sgst,
         case when inter_state then round(taxable * 0.05, 2) else 0 end  as igst
    from priced
)
insert into sales_invoice (tenant_id, invoice_no, invoice_date, party_id, place_of_supply,
                           supply_type, taxable_value, cgst_amount, sgst_amount, igst_amount,
                           round_off, invoice_total, status, created_by, created_at)
select '11111111-1111-1111-1111-111111111111',
       'LOAD/26-27/' || g,
       date '2026-04-01' + (g / 12),
       (array['33333333-0000-0000-0000-000000000701'::uuid,
              '33333333-0000-0000-0000-000000000629'::uuid])[1 + g % 2],
       (array['33','27'])[1 + g % 2],
       (case when inter_state then 'inter_state' else 'intra_state' end)::supply_type,
       taxable, cgst, sgst, igst,
       0,
       -- Derived from the parts, never computed independently: the check
       -- constraint on this table exists precisely to catch the paisa that
       -- an independent calculation loses.
       taxable + cgst + sgst + igst,
       'approved', 'aaaaaaaa-0000-0000-0000-000000000001',
       timestamptz '2026-04-01 18:00+05:30' + (g / 12) * interval '1 day'
  from taxed;

insert into sales_invoice_line (tenant_id, invoice_id, sno, quality_id, hsn_code, description,
                                qty, uom, rate, taxable_value, gst_rate,
                                cgst_rate, cgst_amount, sgst_rate, sgst_amount,
                                igst_rate, igst_amount, line_total)
select i.tenant_id, i.id, 1, '44444444-0000-0000-0000-000000000001', '551311',
       'Galaxy shirting', round(i.taxable_value / 80, 2), 'MTR', 80,
       i.taxable_value, 5,
       case when i.supply_type = 'intra_state' then 2.5 else 0 end, i.cgst_amount,
       case when i.supply_type = 'intra_state' then 2.5 else 0 end, i.sgst_amount,
       case when i.supply_type = 'inter_state' then 5 else 0 end, i.igst_amount,
       i.invoice_total
  from sales_invoice i where i.invoice_no like 'LOAD/%';

\echo '== vouchers, balanced, one per invoice =='

insert into voucher (tenant_id, voucher_no, voucher_type, voucher_date, narration,
                     source_doc, source_id, is_posted, created_by)
select i.tenant_id, 'LOADSV/' || row_number() over (order by i.invoice_no), 'sales',
       i.invoice_date, 'Tax invoice ' || i.invoice_no, 'sales_invoice', i.id, true,
       'aaaaaaaa-0000-0000-0000-000000000001'
  from sales_invoice i where i.invoice_no like 'LOAD/%';

insert into voucher_line (tenant_id, voucher_id, ledger_id, debit, credit)
select v.tenant_id, v.id, i.party_id, i.invoice_total, 0
  from voucher v join sales_invoice i on i.id = v.source_id
 where v.voucher_no like 'LOADSV/%'
union all
select v.tenant_id, v.id, '33333333-0000-0000-0000-000000000901', 0, i.taxable_value
  from voucher v join sales_invoice i on i.id = v.source_id
 where v.voucher_no like 'LOADSV/%'
union all
select v.tenant_id, v.id, '33333333-0000-0000-0000-000000000912', 0, i.igst_amount
  from voucher v join sales_invoice i on i.id = v.source_id
 where v.voucher_no like 'LOADSV/%' and i.igst_amount > 0
union all
select v.tenant_id, v.id, '33333333-0000-0000-0000-000000000910', 0, i.cgst_amount
  from voucher v join sales_invoice i on i.id = v.source_id
 where v.voucher_no like 'LOADSV/%' and i.cgst_amount > 0
union all
select v.tenant_id, v.id, '33333333-0000-0000-0000-000000000911', 0, i.sgst_amount
  from voucher v join sales_invoice i on i.id = v.source_id
 where v.voucher_no like 'LOADSV/%' and i.sgst_amount > 0;

set session_replication_role = 'origin';

analyze;

\echo '== what we built =='
select (select count(*) from piece)          as pieces,
       (select count(*) from piece_movement) as movements,
       (select count(*) from sales_invoice)  as invoices,
       (select count(*) from voucher_line)   as voucher_lines,
       pg_size_pretty(pg_database_size(current_database())) as size;
