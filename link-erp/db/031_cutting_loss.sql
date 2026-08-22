alter table piece_regroup
  add column loss_qty numeric(10,2) not null default 0,
  add column loss_grey numeric(12,2) not null default 0,
  add column loss_jobwork numeric(12,2) not null default 0,
  add column loss_other numeric(12,2) not null default 0;

alter table piece_regroup add constraint piece_regroup_loss_positive check (loss_qty >= 0);

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
   and r.tenant_id = current_setting('app.tenant_id', true)::uuid
   and (coalesce(l.qty, 0) + r.loss_qty <> coalesce(m.consumed_qty, 0)
        or coalesce(m.produced_qty, 0) + r.loss_qty <> coalesce(m.consumed_qty, 0));
