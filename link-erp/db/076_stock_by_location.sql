-- Stock by godown, branch or outlet.
--
-- A mill with a Bhiwandi godown and a Surat outlet could see one stock figure
-- and had no way to ask which building it was standing in. The pieces knew —
-- piece.business_location_id has been there since 057 — but no report read it.
--
-- Accounting statements are deliberately NOT given this dimension. A voucher
-- carries no location in this schema, so a branch-wise trial balance would
-- have to invent one, and an invented split is worse than an absent one. If a
-- mill needs branch accounts, the honest change is to tag postings with a
-- location at source, not to apportion them in a report.

-- Columns are appended; every existing column stands exactly as it was.
create or replace view v_stock_summary as
select p.tenant_id, p.status, q.name as quality, g.name as grade,
       count(*) as pcs, sum(p.current_qty) as qty, sum(p.current_weight_kg) as weight_kg,
       coalesce(bl.code, '—') as location_code,
       coalesce(bl.name, 'Unassigned') as location,
       coalesce(bl.kind::text, 'unassigned') as location_kind
  from piece p
  join quality q on q.id = p.quality_id
  join grade g on g.tenant_id = p.tenant_id and g.code = p.grade_code
  left join business_location bl on bl.id = p.business_location_id
 where p.status in ('grey_in_stock','received_finish','cut_packed')
   and p.tenant_id = current_setting('app.tenant_id', true)::uuid
 group by p.tenant_id, p.status, q.name, g.name, bl.code, bl.name, bl.kind;

create or replace view v_stock_valuation as
select p.tenant_id, p.status, q.name as quality, g.name as grade,
       count(*)                                          as pcs,
       sum(p.current_qty)                                as qty,
       sum(p.grey_cost)                                  as grey_cost,
       sum(p.jobwork_cost)                               as jobwork_cost,
       sum(p.grey_cost + p.jobwork_cost + p.other_cost)  as total_cost,
       round(sum(p.grey_cost + p.jobwork_cost + p.other_cost)
             / nullif(sum(p.current_qty), 0), 2)         as cost_per_mtr,
       coalesce(bl.code, '—') as location_code,
       coalesce(bl.name, 'Unassigned') as location,
       coalesce(bl.kind::text, 'unassigned') as location_kind
  from piece p
  join quality q on q.id = p.quality_id
  join grade g on g.tenant_id = p.tenant_id and g.code = p.grade_code
  left join business_location bl on bl.id = p.business_location_id
 where p.status in ('grey_in_stock','issued_to_dyeing','received_finish','cut_packed','reprocess_at_process_house')
   and p.tenant_id = current_setting('app.tenant_id', true)::uuid
 group by p.tenant_id, p.status, q.name, g.name, bl.code, bl.name, bl.kind;

/**
 * One line per godown: what is standing there, and what it is worth. The
 * question an owner asks before sending a tempo to the wrong building.
 */
create or replace view v_stock_by_location as
select p.tenant_id,
       coalesce(bl.code, '—')            as location_code,
       coalesce(bl.name, 'Unassigned')   as location,
       coalesce(bl.kind::text, 'unassigned') as location_kind,
       p.status::text                    as status,
       count(*)                          as pcs,
       sum(p.current_qty)                as qty,
       sum(p.current_weight_kg)          as weight_kg,
       sum(p.grey_cost + p.jobwork_cost + p.other_cost) as total_cost,
       count(distinct p.rack_code) filter (where p.rack_code is not null) as racks_used
  from piece p
  left join business_location bl on bl.id = p.business_location_id
 where p.status in ('grey_in_stock','received_finish','cut_packed')
   and p.tenant_id = current_setting('app.tenant_id', true)::uuid
 group by p.tenant_id, bl.code, bl.name, bl.kind, p.status;

grant select on v_stock_by_location to link_erp_app;
