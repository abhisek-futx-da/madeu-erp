-- Integrity gaps the audit proved by experiment: a dispatch could be invoiced
-- twice concurrently, an invoice could be paid more than it was worth, a filed
-- return could be changed after the fact, and auth state lived in process
-- memory. Each of these is now the database's job, not the application's.

-- --------------------------------------------------- one invoice per dispatch --

/**
 * Proven defect: two concurrent POSTs both passed the unlocked existence check
 * in invoicing.ts and both inserted. Cancelled invoices are excluded so a
 * mistake can be cancelled and the dispatch billed again.
 */
create unique index if not exists sales_invoice_one_per_dispatch
  on sales_invoice (dispatch_id)
  where dispatch_id is not null and status <> 'cancelled';

-- ------------------------------------------------ allocations fit the invoice --

/**
 * The existing trigger capped allocations against the *payment*. Nothing capped
 * them against the *invoice*, so two receipts could each settle the same bill
 * and drive the receivable negative. Credit notes reduce what is collectable,
 * so they count against the ceiling.
 */
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
      join payment p on p.id = a.payment_id and p.status <> 'cancelled'
     where a.sales_invoice_id = new.sales_invoice_id;
  else
    select pi.invoice_total, pi.our_ref into ceiling, label
      from purchase_invoice pi where pi.id = new.purchase_invoice_id;

    select coalesce(sum(a.amount), 0) into allocated
      from payment_allocation a
      join payment p on p.id = a.payment_id and p.status <> 'cancelled'
     where a.purchase_invoice_id = new.purchase_invoice_id;
  end if;

  if allocated > ceiling + 0.005 then
    raise exception 'allocations (%) exceed % which is collectable for %',
      allocated, ceiling, coalesce(label, 'that invoice');
  end if;
  return null;
end $$ language plpgsql;

drop trigger if exists allocation_fits_invoice on payment_allocation;
create constraint trigger allocation_fits_invoice
  after insert or update on payment_allocation
  deferrable initially deferred
  for each row execute function allocation_within_invoice();

-- ------------------------------------------------------- balance-sheet natures --

-- Grey and finish stock were classified `capital`, which puts inventory on the
-- equity side of a balance sheet, and discount received was an expense.
alter type account_nature add value if not exists 'current_asset';
alter type account_nature add value if not exists 'fixed_asset';
alter type account_nature add value if not exists 'current_liability';
alter type account_nature add value if not exists 'loan';
