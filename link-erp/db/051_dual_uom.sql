-- A textile thaan is measured in metres and weighed in kilograms at the same
-- time.  The old single `current_qty/uom` pair could represent only one truth.
-- Keep length as the movement spine (existing integrations depend on it) and
-- add a parallel, nullable weight spine.  Null means "not captured", never 0.

alter table piece
  add column if not exists grey_weight_kg numeric(12,3),
  add column if not exists finish_weight_kg numeric(12,3),
  add column if not exists current_weight_kg numeric(12,3);

alter table piece drop constraint if exists piece_weight_non_negative;
alter table piece add constraint piece_weight_non_negative check (
  (grey_weight_kg is null or grey_weight_kg >= 0)
  and (finish_weight_kg is null or finish_weight_kg >= 0)
  and (current_weight_kg is null or current_weight_kg >= 0)
);

alter table piece_movement
  add column if not exists weight_before_kg numeric(12,3),
  add column if not exists weight_after_kg numeric(12,3);

-- Enum equality is not leakproof, so under forced RLS PostgreSQL can keep the
-- status predicate above the security barrier and scan every status in a
-- tenant. These small partial indexes preserve mill-floor response time, while
-- the recent index serves the paged stock screen for mixed status filters.
create index if not exists piece_recent_by_tenant
  on piece(tenant_id, created_at desc);
create index if not exists piece_grey_stock_by_tenant
  on piece(tenant_id) where status='grey_in_stock';
create index if not exists piece_finish_stock_by_tenant
  on piece(tenant_id) where status in ('received_finish','cut_packed');
create index if not exists piece_at_process_by_tenant
  on piece(tenant_id) where status in ('issued_to_dyeing','reprocess_at_process_house');

alter table piece_movement drop constraint if exists movement_weight_non_negative;
alter table piece_movement add constraint movement_weight_non_negative check (
  (weight_before_kg is null or weight_before_kg >= 0)
  and (weight_after_kg is null or weight_after_kg >= 0)
);

alter table grey_inward_line
  add column if not exists gross_weight_kg numeric(12,3),
  add column if not exists tare_weight_kg numeric(12,3),
  add column if not exists net_weight_kg numeric(12,3),
  add column if not exists rate_uom text not null default 'MTR';

alter table grey_inward_line drop constraint if exists inward_weight_sane;
alter table grey_inward_line add constraint inward_weight_sane check (
  (gross_weight_kg is null or gross_weight_kg >= 0)
  and (tare_weight_kg is null or tare_weight_kg >= 0)
  and (net_weight_kg is null or net_weight_kg >= 0)
  and (gross_weight_kg is null or tare_weight_kg is null or net_weight_kg is null
       or abs(net_weight_kg - (gross_weight_kg - tare_weight_kg)) <= 0.005)
  and rate_uom in ('MTR','KGS')
  and (rate_uom <> 'KGS' or coalesce(net_weight_kg,0) > 0)
);

-- The original generated amount always multiplied metres by rate. Rebuild the
-- one dependent report around a dual-basis generated amount so kg purchases
-- capitalise the weighed cost rather than a fictional metre cost.
drop view v_quality_margin;
alter table grey_inward_line drop column amount;
alter table grey_inward_line add column amount numeric(14,2) generated always as (
  (case when rate_uom='KGS' then net_weight_kg else checked_qty end) * rate
) stored;

create view v_quality_margin as
with sold as (
  select sl.tenant_id, q.id as quality_id, q.name as quality,
         sum(sl.qty) as qty_sold, sum(sl.taxable_value) as revenue
    from sales_invoice_line sl
    join sales_invoice si on si.id = sl.invoice_id and is_live(si.status)
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

grant select on v_quality_margin to link_erp_app;

alter table dyeing_issue_line
  add column if not exists issued_weight_kg numeric(12,3);
alter table dyeing_receipt_line
  add column if not exists received_weight_kg numeric(12,3);
alter table dyeing_reprocess_line
  add column if not exists issued_weight_kg numeric(12,3);
alter table dyeing_reprocess_receipt_line
  add column if not exists received_weight_kg numeric(12,3);

create or replace function piece_movement_guard() returns trigger as $$
begin
  if new.from_status is not null
     and not exists (select 1 from piece_status_transition
                     where from_status = new.from_status and to_status = new.to_status) then
    raise exception 'illegal piece transition % -> %', new.from_status, new.to_status;
  end if;
  update piece
     set status = new.to_status,
         current_qty = new.qty_after,
         current_weight_kg = coalesce(new.weight_after_kg, current_weight_kg),
         held_by_ledger_id = new.counterparty_id,
         rack_code = coalesce(new.to_rack, rack_code),
         updated_at = now()
   where id = new.piece_id;
  return new;
end $$ language plpgsql;

create or replace view v_piece_dual_uom as
select p.tenant_id, p.id as piece_id, p.barcode, p.lot_no, p.status,
       p.current_qty as metres, p.current_weight_kg as kilograms,
       q.width_cms,
       case when p.current_qty > 0 and p.current_weight_kg is not null
            then round(p.current_weight_kg * 1000 / p.current_qty, 3) end as glm,
       case when p.current_qty > 0 and p.current_weight_kg is not null and q.width_cms > 0
            then round(p.current_weight_kg * 100000 / (p.current_qty * q.width_cms), 3) end as gsm
  from piece p
 join quality q on q.id = p.quality_id
 where p.tenant_id = current_setting('app.tenant_id', true)::uuid;

grant select on v_piece_dual_uom to link_erp_app;

create or replace view v_barcode_history as
select m.tenant_id, p.barcode, p.lot_no, q.name as quality, d.name as design,
       m.event, m.from_status, m.to_status, m.qty_before, m.qty_after,
       l.name as counterparty, m.doc_type, m.occurred_at,
       m.from_rack, m.to_rack, m.note,
       m.weight_before_kg, m.weight_after_kg
  from piece_movement m
  join piece p on p.id = m.piece_id
  join quality q on q.id = p.quality_id
  left join design d on d.id = p.design_id
  left join ledger_account l on l.id = m.counterparty_id
 where m.tenant_id = current_setting('app.tenant_id', true)::uuid;

create or replace view v_process_stock as
select p.tenant_id, l.name as process_house, q.name as quality,
       count(*) as pcs, sum(p.current_qty) as qty,
       case p.status
         when 'issued_to_dyeing' then 'First process'
         when 'reprocess_at_process_house' then 'Reprocess'
       end as stage,
       sum(p.current_weight_kg) as weight_kg
  from piece p
  join ledger_account l on l.id = p.held_by_ledger_id
  join quality q on q.id = p.quality_id
 where p.status in ('issued_to_dyeing','reprocess_at_process_house')
   and p.tenant_id = current_setting('app.tenant_id', true)::uuid
 group by p.tenant_id, l.name, q.name, p.status;

create or replace view v_stock_summary as
select p.tenant_id, p.status, q.name as quality, g.name as grade,
       count(*) as pcs, sum(p.current_qty) as qty, sum(p.current_weight_kg) as weight_kg
  from piece p
  join quality q on q.id = p.quality_id
  join grade g on g.tenant_id = p.tenant_id and g.code = p.grade_code
 where p.status in ('grey_in_stock','received_finish','cut_packed')
   and p.tenant_id = current_setting('app.tenant_id', true)::uuid
 group by p.tenant_id, p.status, q.name, g.name;

create or replace view v_shrinkage_by_process_house as
select r.tenant_id, l.name as process_house, q.name as quality,
       count(*) as pieces,
       sum(rl.issued_qty) as issued_qty,
       sum(rl.received_qty) as received_qty,
       round(sum(rl.shrinkage_qty) * 100 / nullif(sum(rl.issued_qty), 0), 3) as shrinkage_pct,
       sum(il.issued_weight_kg) as issued_weight_kg,
       sum(rl.received_weight_kg) as received_weight_kg,
       round((sum(il.issued_weight_kg)-sum(rl.received_weight_kg))*100 /
             nullif(sum(il.issued_weight_kg),0),3) as weight_shrinkage_pct
  from dyeing_receipt_line rl
  join dyeing_receipt r on r.id = rl.receipt_id
  join dyeing_issue_line il on il.id=rl.issue_line_id
  join ledger_account l on l.id = r.process_house_id
  join piece p on p.id = rl.piece_id
  join quality q on q.id = p.quality_id
 where r.tenant_id = current_setting('app.tenant_id', true)::uuid
 group by r.tenant_id, l.name, q.name;

grant select on v_barcode_history,v_process_stock,v_stock_summary,
  v_shrinkage_by_process_house to link_erp_app;
