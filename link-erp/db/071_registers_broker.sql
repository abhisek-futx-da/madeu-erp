-- Every trade here is brokered, and the registers did not say by whom. An
-- owner asking "show me Ramesh dalal's sales this month" had no way to get an
-- answer out of the sales register, though the broker was on the invoice the
-- whole time. Both registers gain the broker and his rate; create-or-replace
-- appends, so the existing columns stand exactly as they were.

create or replace view v_sales_register as
select i.tenant_id, i.id as invoice_id, i.invoice_no, i.invoice_date,
       p.code as party_code, p.name as party, p.gstin as party_gstin,
       i.place_of_supply, i.supply_type::text as supply_type,
       i.taxable_value, i.cgst_amount, i.sgst_amount, i.igst_amount,
       i.cgst_amount + i.sgst_amount + i.igst_amount as tax_amount,
       i.round_off, i.invoice_total,
       i.status::text as status, g.irn, v.voucher_no,
       b.name as broker, i.brokerage_amount
  from sales_invoice i
  join ledger_account p on p.id = i.party_id
  left join ledger_account b on b.id = i.broker_id
  left join voucher v on v.id = i.voucher_id
  left join gst_document g on g.voucher_id = i.voucher_id
 where is_live(i.status)
   and i.tenant_id = current_setting('app.tenant_id', true)::uuid;

/**
 * A grey bill's broker comes from the delivery it settles: the broker is
 * agreed on the sauda and recorded on the inward, not re-keyed onto the bill.
 * A bill standing on its own has no broker, and says so rather than guessing.
 */
create or replace view v_purchase_register as
select i.tenant_id, i.id as invoice_id, i.our_ref, i.supplier_invoice_no,
       i.invoice_date, p.code as party_code, p.name as party, p.gstin as party_gstin,
       i.place_of_supply, i.supply_type::text as supply_type, i.is_rcm,
       i.taxable_value, i.cgst_amount, i.sgst_amount, i.igst_amount,
       i.cgst_amount + i.sgst_amount + i.igst_amount as tax_amount,
       i.round_off, i.invoice_total, i.itc_eligible,
       i.status::text as status, v.voucher_no,
       b.name as broker
  from purchase_invoice i
  join ledger_account p on p.id = i.party_id
  left join voucher v on v.id = i.voucher_id
  left join grey_inward gi
         on gi.id = i.source_id and i.source_doc = 'grey_inward'
  left join ledger_account b on b.id = gi.broker_id
 where is_live(i.status)
   and i.tenant_id = current_setting('app.tenant_id', true)::uuid;
