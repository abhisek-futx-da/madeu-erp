-- Production operations: auditable opening stock and traceable stock movement
-- between business locations.  Neither creates revenue or purchases; opening
-- inventory is reconciled to explicit opening ledger balances, while a godown
-- transfer changes custody only and therefore posts no voucher.

-- --------------------------------------------------------- opening stock --

create table opening_stock_batch (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references tenant(id) on delete cascade,
  fy_label              text not null,
  batch_no              text not null,
  stock_date            date not null,
  business_location_id uuid not null,
  remarks               text not null default '',
  status                doc_status not null default 'approved',
  created_by            uuid not null references app_user(id),
  created_at            timestamptz not null default now(),
  unique (tenant_id,batch_no),
  unique (id,tenant_id),
  foreign key (tenant_id,fy_label) references financial_year(tenant_id,label),
  foreign key (business_location_id,tenant_id)
    references business_location(id,tenant_id)
);

alter table piece add constraint piece_id_tenant_unique unique(id,tenant_id);

create table opening_stock_line (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenant(id) on delete cascade,
  batch_id        uuid not null,
  piece_id        uuid not null,
  sno             integer not null check (sno > 0),
  stock_kind      text not null check (stock_kind in ('grey','finish')),
  original_qty    numeric(10,2) not null check (original_qty > 0),
  original_weight_kg numeric(12,3) check (original_weight_kg is null or original_weight_kg >= 0),
  grey_value      numeric(12,2) not null default 0 check (grey_value >= 0),
  jobwork_value   numeric(12,2) not null default 0 check (jobwork_value >= 0),
  other_value     numeric(12,2) not null default 0 check (other_value >= 0),
  unique (batch_id,sno),
  unique (piece_id),
  foreign key (batch_id,tenant_id) references opening_stock_batch(id,tenant_id),
  foreign key (piece_id,tenant_id) references piece(id,tenant_id)
);
create index opening_stock_batch_location_fk
  on opening_stock_batch(tenant_id,business_location_id);
create index opening_stock_line_batch_fk on opening_stock_line(tenant_id,batch_id);
create index opening_stock_line_piece_fk on opening_stock_line(tenant_id,piece_id);

create or replace function opening_stock_guard()
returns trigger language plpgsql as $$
declare configured_start date; configured_end date;
begin
  if exists (select 1 from voucher where tenant_id=new.tenant_id and is_posted) then
    raise exception 'opening stock is locked after the first posted voucher';
  end if;
  select starts_on,ends_on into configured_start,configured_end
    from financial_year where tenant_id=new.tenant_id and label=new.fy_label and status='open';
  if configured_start is null then raise exception 'opening stock requires the open financial year'; end if;
  if new.stock_date not between configured_start and configured_end then
    raise exception 'opening stock date is outside its financial year';
  end if;
  if not exists (select 1 from business_location where id=new.business_location_id
                  and tenant_id=new.tenant_id and is_active) then
    raise exception 'opening stock location is not active for this company';
  end if;
  return new;
end;
$$;
create trigger opening_stock_guard before insert on opening_stock_batch
for each row execute function opening_stock_guard();

-- ------------------------------------------------------- godown transfer --

alter type movement_event add value if not exists 'transfer';

alter table piece_movement
  add column from_location_id uuid,
  add column to_location_id uuid,
  add constraint movement_from_location_fk
    foreign key (from_location_id,tenant_id) references business_location(id,tenant_id),
  add constraint movement_to_location_fk
    foreign key (to_location_id,tenant_id) references business_location(id,tenant_id);
create index movement_from_location_fk on piece_movement(tenant_id,from_location_id)
  where from_location_id is not null;
create index movement_to_location_fk on piece_movement(tenant_id,to_location_id)
  where to_location_id is not null;

create table location_transfer (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references tenant(id) on delete cascade,
  transfer_no          text not null,
  transfer_date        date not null,
  from_location_id     uuid not null,
  to_location_id       uuid not null,
  remarks              text not null default '',
  status               doc_status not null default 'approved',
  created_by           uuid not null references app_user(id),
  cancelled_by         uuid references app_user(id),
  cancelled_at         timestamptz,
  cancellation_reason  text,
  created_at           timestamptz not null default now(),
  unique (tenant_id,transfer_no),
  unique (id,tenant_id),
  foreign key (from_location_id,tenant_id) references business_location(id,tenant_id),
  foreign key (to_location_id,tenant_id) references business_location(id,tenant_id),
  constraint transfer_different_locations check (from_location_id<>to_location_id),
  constraint transfer_cancellation_complete check (
    (status='cancelled') = (cancelled_at is not null and cancelled_by is not null
                            and cancellation_reason is not null)
  )
);

create table location_transfer_line (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenant(id) on delete cascade,
  transfer_id    uuid not null,
  piece_id       uuid not null,
  sno            integer not null check (sno > 0),
  from_rack      text,
  to_rack        text,
  transferred_qty numeric(10,2) not null check (transferred_qty > 0),
  unique (transfer_id,sno),
  unique (transfer_id,piece_id),
  foreign key (transfer_id,tenant_id) references location_transfer(id,tenant_id),
  foreign key (piece_id,tenant_id) references piece(id,tenant_id),
  foreign key (tenant_id,from_rack) references rack_master(tenant_id,code),
  foreign key (tenant_id,to_rack) references rack_master(tenant_id,code)
);
create index location_transfer_from_fk on location_transfer(tenant_id,from_location_id);
create index location_transfer_to_fk on location_transfer(tenant_id,to_location_id);
create index location_transfer_cancelled_by_fk on location_transfer(tenant_id,cancelled_by);
create index location_transfer_line_transfer_fk on location_transfer_line(tenant_id,transfer_id);
create index location_transfer_line_piece_fk on location_transfer_line(tenant_id,piece_id);

-- A transfer is the only same-status movement that may change a business
-- location.  It must describe the piece exactly as it is while locked, and its
-- destination rack (when supplied) must belong to the destination location.
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
  update piece
     set status=new.to_status,current_qty=new.qty_after,
         current_weight_kg=coalesce(new.weight_after_kg,current_weight_kg),
         held_by_ledger_id=new.counterparty_id,rack_code=coalesce(new.to_rack,rack_code),
         updated_at=now()
   where id=new.piece_id;
  return new;
end $$ language plpgsql;

create or replace view v_barcode_history as
select m.tenant_id,p.barcode,p.lot_no,q.name as quality,d.name as design,
       m.event,m.from_status,m.to_status,m.qty_before,m.qty_after,
       l.name as counterparty,m.doc_type,m.occurred_at,
       m.from_rack,m.to_rack,m.note,m.weight_before_kg,m.weight_after_kg,
       fl.name as from_location,tl.name as to_location
  from piece_movement m
  join piece p on p.id=m.piece_id
  join quality q on q.id=p.quality_id
  left join design d on d.id=p.design_id
  left join ledger_account l on l.id=m.counterparty_id
  left join business_location fl on fl.id=m.from_location_id
  left join business_location tl on tl.id=m.to_location_id
 where m.tenant_id=current_setting('app.tenant_id',true)::uuid;

create or replace view v_location_stock as
select p.tenant_id,p.business_location_id,l.code as location_code,l.name as location,
       p.rack_code,p.status,q.name as quality,p.grade_code,
       count(*)::int as pieces,sum(p.current_qty) as quantity,
       sum(p.grey_cost+p.jobwork_cost+p.other_cost) as stock_value
  from piece p join business_location l on l.id=p.business_location_id
  join quality q on q.id=p.quality_id
 where p.tenant_id=current_setting('app.tenant_id',true)::uuid
   and p.status in ('grey_in_stock','received_finish','cut_packed')
 group by p.tenant_id,p.business_location_id,l.code,l.name,p.rack_code,p.status,q.name,p.grade_code;

insert into document_series (tenant_id,doc_type,fy_label,prefix,next_number)
select fy.tenant_id,x.doc_type,fy.label,x.prefix || right(fy.label,5) || '/',1
  from financial_year fy
 cross join (values ('opening_stock','OS/'),('location_transfer','LT/')) x(doc_type,prefix)
on conflict (tenant_id,doc_type,fy_label) do nothing;

-- ---------------------------------------------------------- RLS / grants --

do $$ declare table_name text; begin
  foreach table_name in array array[
    'opening_stock_batch','opening_stock_line','location_transfer','location_transfer_line'
  ] loop
    execute format('alter table %I enable row level security',table_name);
    execute format('alter table %I force row level security',table_name);
    execute format(
      'create policy tenant_isolation on %I using (tenant_id=current_setting(''app.tenant_id'',true)::uuid) with check (tenant_id=current_setting(''app.tenant_id'',true)::uuid)',
      table_name);
    execute format('grant select,insert,update on %I to link_erp_app',table_name);
  end loop;
end $$;
grant usage,select on all sequences in schema public to link_erp_app;
grant select on v_barcode_history,v_location_stock to link_erp_app;
