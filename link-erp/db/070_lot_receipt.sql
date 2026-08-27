-- Receiving from a process house that cannot return the barcodes it was sent.
--
-- The piece-wise receipt assumes the label on a grey thaan survives desizing,
-- caustic scouring, bleaching, a 130C jet and a stenter, and comes back on the
-- same cloth. In plenty of mills it does not: thaans are stitched end to end
-- into one batch for the machine, and the batch is cut into finished lengths
-- at the inspection table. Nothing that went in comes back as itself.
--
-- So a receipt may now be taken against the *issue* rather than the piece.
-- The pieces that went out are consumed, new pieces are created at the
-- inspection table with their own barcodes, and the cost that was on the
-- parents follows the children. Quantities reconcile at lot level, which is
-- the level at which the process house and the mill actually agree.

alter type regroup_kind add value if not exists 'process_return';
alter type movement_event add value if not exists 'process_return';

insert into piece_status_transition (from_status, to_status) values
  ('issued_to_dyeing','consumed'),
  ('reprocess_at_process_house','consumed'),
  -- The reverse legs exist so a mis-keyed lot receipt can be cancelled.
  ('consumed','issued_to_dyeing'),
  ('consumed','reprocess_at_process_house')
on conflict (from_status, to_status) do nothing;

/**
 * Goods lying at a process house are still not ours to cut. Consuming them is
 * legal only as a process return — the house handing cloth back in different
 * physical units — and never as a split or a merge the mill performs on stock
 * it does not hold. The transition alone cannot say this, so the guard does.
 */
create or replace function piece_movement_guard() returns trigger as $$
declare
  piece_tenant uuid; piece_status_now piece_status; piece_qty numeric(10,2);
  piece_weight numeric(12,3); piece_holder uuid; piece_rack text;
  piece_location uuid; destination_rack_location uuid;
begin
  select tenant_id,status,current_qty,current_weight_kg,held_by_ledger_id,rack_code,
         business_location_id
    into piece_tenant,piece_status_now,piece_qty,piece_weight,piece_holder,piece_rack,
         piece_location
    from piece where id=new.piece_id for update;
  if piece_tenant is null or piece_tenant<>new.tenant_id then
    raise exception 'piece movement crosses companies';
  end if;

  if new.event='transfer' then
    if piece_holder is not null or piece_status_now not in ('grey_in_stock','received_finish','cut_packed') then
      raise exception 'only available mill stock can move between business locations';
    end if;
    if new.from_status is null or new.from_status<>new.to_status or piece_status_now<>new.from_status then
      raise exception 'a location transfer cannot change piece status';
    end if;
    if new.from_location_id is null or new.to_location_id is null
       or piece_location<>new.from_location_id or new.from_location_id=new.to_location_id then
      raise exception 'location transfer does not match current and destination locations';
    end if;
    if piece_qty<>new.qty_before or new.qty_before<>new.qty_after then
      raise exception 'a location transfer cannot change quantity';
    end if;
    if new.weight_after_kg is not null and piece_weight is distinct from new.weight_before_kg then
      raise exception 'location transfer does not match current weight';
    end if;
    if new.to_rack is not null then
      select business_location_id into destination_rack_location from rack_master
       where tenant_id=new.tenant_id and code=new.to_rack;
      if destination_rack_location is null or destination_rack_location<>new.to_location_id then
        raise exception 'destination rack does not belong to the destination location';
      end if;
    end if;
    update piece set business_location_id=new.to_location_id,rack_code=new.to_rack,updated_at=now()
     where id=new.piece_id;
    return new;
  end if;

  if new.from_status is not null
     and not exists (select 1 from piece_status_transition
                     where from_status=new.from_status and to_status=new.to_status) then
    raise exception 'illegal piece transition % -> %',new.from_status,new.to_status;
  end if;

  -- The one rule this migration adds.
  if new.to_status='consumed'
     and new.from_status in ('issued_to_dyeing','reprocess_at_process_house')
     and new.event<>'process_return' then
    raise exception
      'a piece out at a process house can only be consumed by a process return, not by %',
      new.event;
  end if;

  update piece
     set status=new.to_status,current_qty=new.qty_after,
         current_weight_kg=coalesce(new.weight_after_kg,current_weight_kg),
         held_by_ledger_id=new.counterparty_id,rack_code=coalesce(new.to_rack,rack_code),
         updated_at=now()
   where id=new.piece_id;
  return new;
end $$ language plpgsql;

/**
 * How the receipt was taken. 'piece' is the original flow and stays the
 * default; 'lot' means the quantities were agreed against the issue as a
 * whole and the finished pieces are new.
 *
 * On a lot receipt each dyeing_receipt_line still stands against its issue
 * line, carrying that line's pro-rata share of what the lot returned. Nobody
 * can say which grey thaan became which finished thaan — the process house
 * returned a batch — so the share is explicit and stated, and every report
 * built on receipt lines (shrinkage, ITC-04, job-work ageing) keeps working.
 */
alter table dyeing_receipt add column if not exists receipt_mode text not null default 'piece';
alter table dyeing_receipt drop constraint if exists receipt_mode_known;
alter table dyeing_receipt add constraint receipt_mode_known
  check (receipt_mode in ('piece', 'lot'));

alter table dyeing_receipt add column if not exists issue_id uuid references dyeing_issue(id);
alter table dyeing_receipt drop constraint if exists lot_receipt_names_its_issue;
alter table dyeing_receipt add constraint lot_receipt_names_its_issue
  check (receipt_mode = 'piece' or issue_id is not null);

alter table dyeing_receipt add column if not exists regroup_id uuid references piece_regroup(id);

create index if not exists receipt_by_issue on dyeing_receipt (issue_id) where issue_id is not null;
create index if not exists receipt_by_regroup on dyeing_receipt (regroup_id) where regroup_id is not null;

/**
 * A split or a merge must conserve its metres exactly; a process return must
 * not. Cloth genuinely comes back shorter than the grey that went in, and
 * that difference is shrinkage — already judged against the agreed policy
 * when the receipt is taken, and reported by process house and by lot. Left
 * in, every lot receipt would raise a false alarm here and the report would
 * stop being read. Columns are unchanged from 026.
 */
create or replace view v_regroup_imbalance as
select r.tenant_id, r.id as regroup_id, r.entry_no, r.kind::text as kind,
       coalesce(l.qty, 0)           as lineage_qty,
       coalesce(m.consumed_qty, 0)  as consumed_qty,
       coalesce(m.produced_qty, 0)  as produced_qty,
       r.loss_qty                   as loss_qty
  from piece_regroup r
  left join lateral (
    select sum(qty) as qty from piece_lineage where regroup_id = r.id
  ) l on true
  left join lateral (
    select sum(qty_before) filter (where to_status = 'consumed')  as consumed_qty,
           sum(qty_after)  filter (where to_status <> 'consumed') as produced_qty
      from piece_movement where doc_type = 'piece_regroup' and doc_id = r.id
  ) m on true
 where r.status <> 'cancelled'
   and r.kind <> 'process_return'
   and r.tenant_id = current_setting('app.tenant_id', true)::uuid
   and (coalesce(l.qty, 0) + r.loss_qty <> coalesce(m.consumed_qty, 0)
        or coalesce(m.produced_qty, 0) + r.loss_qty <> coalesce(m.consumed_qty, 0));

-- What a lot receipt actually produced, beside what it consumed.
create or replace view v_lot_receipt as
select dr.tenant_id, dr.id as receipt_id, dr.entry_no, dr.entry_date, dr.challan_no,
       l.name as process_house, di.entry_no as issue_entry_no, di.lot_no,
       count(distinct pl.parent_id)::int              as thaans_sent,
       count(distinct pl.child_id)::int               as thaans_returned,
       coalesce(sum(drl.issued_qty), 0)               as issued_qty,
       coalesce(sum(drl.received_qty), 0)             as received_qty,
       coalesce(sum(drl.issued_qty), 0) - coalesce(sum(drl.received_qty), 0) as shrinkage_qty,
       round((coalesce(sum(drl.issued_qty), 0) - coalesce(sum(drl.received_qty), 0)) * 100
             / nullif(coalesce(sum(drl.issued_qty), 0), 0), 3) as shrinkage_pct,
       dr.status::text as status
  from dyeing_receipt dr
  join dyeing_issue di on di.id = dr.issue_id
  join ledger_account l on l.id = dr.process_house_id
  left join dyeing_receipt_line drl on drl.receipt_id = dr.id and drl.active
  left join piece_lineage pl on pl.regroup_id = dr.regroup_id
 where dr.receipt_mode = 'lot'
   and dr.tenant_id = current_setting('app.tenant_id', true)::uuid
 group by dr.tenant_id, dr.id, dr.entry_no, dr.entry_date, dr.challan_no,
          l.name, di.entry_no, di.lot_no, dr.status;

grant select on v_lot_receipt to link_erp_app;
