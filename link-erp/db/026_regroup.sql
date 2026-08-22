-- Partial rolls. A thaan gets cut in half on a converter's floor every day and
-- the spine had no way to say so: a piece could only ever move whole, so the
-- half that stayed behind was tracked on paper and the stock ledger drifted
-- from the rack the moment anyone picked up a cutter.
--
-- A piece stops naming physical goods when it is split into children or merged
-- into a successor. Both are the same fact — "this barcode is finished, see
-- where it went" — so both land in one status and one lineage table.

alter type piece_status  add value if not exists 'consumed';
alter type movement_event add value if not exists 'split';
alter type movement_event add value if not exists 'merge';

-- Only from our own custody: goods lying at a process house are not ours to
-- cut. The reverse legs exist so a mis-keyed regroup can be cancelled.
insert into piece_status_transition (from_status, to_status) values
  ('grey_in_stock','consumed'),  ('received_finish','consumed'),
  ('cut_packed','consumed'),
  ('consumed','grey_in_stock'),  ('consumed','received_finish'),
  ('consumed','cut_packed')
on conflict (from_status, to_status) do nothing;

create type regroup_kind as enum ('split','merge');

create table piece_regroup (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenant(id) on delete cascade,
  entry_no    text not null,
  entry_date  date not null,
  kind        regroup_kind not null,
  reason      text not null default '',
  status      doc_status not null default 'approved',
  created_by  uuid references app_user(id),
  created_at  timestamptz not null default now(),
  unique (tenant_id, entry_no)
);
create index regroup_by_date on piece_regroup (tenant_id, entry_date desc, entry_no desc);

-- Append-only: which barcode became which, how much went with it, and what it
-- carried. The cost columns are what makes a split reversible without guessing.
create table piece_lineage (
  id           bigserial primary key,
  tenant_id    uuid not null references tenant(id) on delete cascade,
  regroup_id   uuid not null references piece_regroup(id),
  parent_id    uuid not null references piece(id),
  child_id     uuid not null references piece(id),
  qty          numeric(10,2) not null,
  grey_cost    numeric(12,2) not null default 0,
  jobwork_cost numeric(12,2) not null default 0,
  other_cost   numeric(12,2) not null default 0,
  cost         numeric(12,2) generated always as (grey_cost + jobwork_cost + other_cost) stored,
  created_at   timestamptz not null default now(),
  constraint lineage_qty_positive check (qty > 0),
  constraint lineage_not_self check (parent_id <> child_id),
  unique (regroup_id, parent_id, child_id)
);
create index lineage_by_parent  on piece_lineage (parent_id);
create index lineage_by_child   on piece_lineage (child_id);
create index lineage_by_regroup on piece_lineage (regroup_id);
create index lineage_by_tenant  on piece_lineage (tenant_id);

create rule piece_lineage_no_update as on update to piece_lineage do instead nothing;
create rule piece_lineage_no_delete as on delete to piece_lineage do instead nothing;

-- Where a barcode came from and what it became.
create view v_piece_lineage as
select pl.tenant_id, r.entry_no, r.entry_date, r.kind::text as kind, r.reason,
       r.status::text as doc_status,
       parent.barcode as from_barcode, child.barcode as to_barcode,
       pl.qty, pl.cost, child.status::text as to_status
  from piece_lineage pl
  join piece_regroup r on r.id = pl.regroup_id
  join piece parent on parent.id = pl.parent_id
  join piece child  on child.id  = pl.child_id
 where pl.tenant_id = current_setting('app.tenant_id', true)::uuid;

-- A regroup conserves metres: what was consumed equals what was produced
-- equals what the lineage claims moved. A row here is a defect, exactly the
-- way a row in v_piece_drift is. Cancellation movements carry their own
-- doc_type, so a cancelled regroup's sums stay readable.
create view v_regroup_imbalance as
select r.tenant_id, r.id as regroup_id, r.entry_no, r.kind::text as kind,
       coalesce(l.qty, 0)           as lineage_qty,
       coalesce(m.consumed_qty, 0)  as consumed_qty,
       coalesce(m.produced_qty, 0)  as produced_qty
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
   and (coalesce(l.qty, 0) <> coalesce(m.consumed_qty, 0)
        or coalesce(l.qty, 0) <> coalesce(m.produced_qty, 0));

grant select, insert, update, delete on piece_regroup, piece_lineage to link_erp_app;
grant usage, select on sequence piece_lineage_id_seq to link_erp_app;
grant select on v_piece_lineage, v_regroup_imbalance to link_erp_app;

do $$
declare t text;
begin
  foreach t in array array['piece_regroup','piece_lineage'] loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy tenant_isolation on %I using (tenant_id = current_setting(''app.tenant_id'', true)::uuid)'
      || ' with check (tenant_id = current_setting(''app.tenant_id'', true)::uuid)', t);
  end loop;
end $$;
