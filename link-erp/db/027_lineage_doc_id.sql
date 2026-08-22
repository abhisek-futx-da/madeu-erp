-- The lineage view named the entry but not its id, so a screen showing a cut
-- could describe it and not undo it. Appended rather than inserted in place:
-- `create or replace view` may only add columns at the end.

create or replace view v_piece_lineage as
select pl.tenant_id, r.entry_no, r.entry_date, r.kind::text as kind, r.reason,
       r.status::text as doc_status,
       parent.barcode as from_barcode, child.barcode as to_barcode,
       pl.qty, pl.cost, child.status::text as to_status,
       pl.regroup_id
  from piece_lineage pl
  join piece_regroup r on r.id = pl.regroup_id
  join piece parent on parent.id = pl.parent_id
  join piece child  on child.id  = pl.child_id
 where pl.tenant_id = current_setting('app.tenant_id', true)::uuid;
