-- Engineering hygiene: index the foreign keys that line tables join on, record
-- which migrations have run, and make the cached piece fold verifiable.

-- ------------------------------------------------- migration bookkeeping --

create table if not exists schema_migration (
  filename    text primary key,
  applied_at  timestamptz not null default now(),
  checksum    text
);

-- ------------------------------------------------------------- indexes --

-- Every one of these is a foreign key a line table joins or filters on; without
-- them each lookup degrades to a sequential scan as volume arrives.
create index if not exists sil_by_invoice   on sales_invoice_line (invoice_id);
create index if not exists sil_by_piece     on sales_invoice_line (piece_id);
create index if not exists sil_by_quality   on sales_invoice_line (quality_id);
create index if not exists pil_by_invoice   on purchase_invoice_line (invoice_id);
create index if not exists dl_by_dispatch   on dispatch_line (dispatch_id);
create index if not exists dl_by_piece      on dispatch_line (piece_id);
create index if not exists dl_by_so_line    on dispatch_line (so_line_id);
create index if not exists dil_by_issue     on dyeing_issue_line (issue_id);
create index if not exists dil_by_piece     on dyeing_issue_line (piece_id);
create index if not exists drl_by_receipt   on dyeing_receipt_line (receipt_id);
create index if not exists drl_by_piece     on dyeing_receipt_line (piece_id);
create index if not exists gil_by_inward    on grey_inward_line (inward_id);
create index if not exists gil_by_po_line   on grey_inward_line (po_line_id);
create index if not exists vl_by_voucher    on voucher_line (voucher_id);
create index if not exists gpol_by_order    on grey_purchase_order_line (order_id);
create index if not exists gpol_by_quality  on grey_purchase_order_line (quality_id);
create index if not exists fsol_by_order    on finish_sales_order_line (order_id);
create index if not exists note_by_invoice  on gst_note (against_invoice_id);
create index if not exists gst_doc_by_inv   on gst_document (invoice_id);
create index if not exists voucher_by_date  on voucher (tenant_id, voucher_date);
create index if not exists voucher_by_source on voucher (tenant_id, source_doc, source_id);
create index if not exists si_by_party      on sales_invoice (tenant_id, party_id);
create index if not exists pi_by_party      on purchase_invoice (tenant_id, party_id);

-- --------------------------------------------------- integrity checking --

/**
 * `piece.current_qty` and `piece.status` are a cached fold of piece_movement.
 * Nothing recomputed them, so a stray UPDATE would desynchronise the spine
 * silently. This makes the drift visible and fixable.
 */
create view v_piece_drift as
select p.tenant_id, p.id as piece_id, p.barcode,
       p.status        as cached_status,
       m.to_status     as log_status,
       p.current_qty   as cached_qty,
       m.qty_after     as log_qty
  from piece p
  join lateral (
    select to_status, qty_after from piece_movement
     where piece_id = p.id order by id desc limit 1
  ) m on true
 where (p.status <> m.to_status or p.current_qty <> m.qty_after)
   and p.tenant_id = current_setting('app.tenant_id', true)::uuid;

create or replace function repair_piece_fold(p_tenant uuid)
returns integer language plpgsql as $$
declare fixed integer;
begin
  with latest as (
    select distinct on (m.piece_id) m.piece_id, m.to_status, m.qty_after
      from piece_movement m
      join piece p on p.id = m.piece_id
     where p.tenant_id = p_tenant
     order by m.piece_id, m.id desc
  )
  update piece p
     set status = l.to_status, current_qty = l.qty_after, updated_at = now()
    from latest l
   where p.id = l.piece_id
     and (p.status <> l.to_status or p.current_qty <> l.qty_after);
  get diagnostics fixed = row_count;
  return fixed;
end $$;

grant select on v_piece_drift to link_erp_app;
grant execute on function repair_piece_fold(uuid) to link_erp_app;
grant select, insert on schema_migration to link_erp_app;

-- Tenant_id leads every RLS predicate, so line tables need it indexed; the
-- remaining three are the foreign keys gst_note joins on.
create index if not exists gil_by_tenant  on grey_inward_line (tenant_id);
create index if not exists dil_by_tenant  on dyeing_issue_line (tenant_id);
create index if not exists drl_by_tenant  on dyeing_receipt_line (tenant_id);
create index if not exists dl_by_tenant   on dispatch_line (tenant_id);
create index if not exists pil_by_tenant  on purchase_invoice_line (tenant_id);
create index if not exists vl_by_ledger   on voucher_line (ledger_id);
create index if not exists note_by_party  on gst_note (party_id);
create index if not exists note_by_vch    on gst_note (voucher_id);
create index if not exists note_by_user   on gst_note (created_by);
