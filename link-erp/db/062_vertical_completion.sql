-- Shared material, resource, stock and job-costing controls for every edition.
-- Operational payloads remain edition-specific; quantities and money enter the
-- common sub-ledger so vertical workflows cannot invent their own stock truth.

alter table edition_document add column parent_document_id uuid;
alter table edition_document add column approval_status text not null default 'not_required'
  check(approval_status in ('not_required','not_submitted','pending','approved','rejected'));
alter table edition_document add column submitted_by uuid references app_user(id);
alter table edition_document add column submitted_at timestamptz;
alter table edition_document add column approval_actor_id uuid references app_user(id);
alter table edition_document add column approval_at timestamptz;
alter table edition_document add column approval_reason text;
alter table edition_document add constraint edition_document_parent_fk
  foreign key(parent_document_id,tenant_id) references edition_document(id,tenant_id);
alter table edition_document add constraint edition_document_not_own_parent
  check(parent_document_id is null or parent_document_id<>id);
create index edition_document_parent_fk_idx on edition_document(tenant_id,parent_document_id);
create index edition_document_submitted_by_fk on edition_document(tenant_id,submitted_by);
create index edition_document_approval_actor_fk on edition_document(tenant_id,approval_actor_id);
alter table edition_document add constraint edition_document_approval_sane check(
  (approval_status='pending')=(submitted_by is not null and submitted_at is not null and approval_actor_id is null and approval_at is null)
  and (approval_status in ('approved','rejected'))=(submitted_by is not null and submitted_at is not null and approval_actor_id is not null and approval_at is not null)
  and (approval_status not in ('not_required','not_submitted') or (approval_actor_id is null and approval_at is null))
);

create or replace function guard_edition_document_transition()
returns trigger language plpgsql as $$
begin
  if old.status=new.status then return new; end if;
  if not ((old.status='draft' and new.status in ('in_progress','cancelled')) or
          (old.status='in_progress' and new.status in ('held','completed','cancelled')) or
          (old.status='held' and new.status in ('in_progress','cancelled'))) then
    raise exception 'edition document cannot move from % to %',old.status,new.status;
  end if;
  if new.status='completed' and new.approval_status not in ('not_required','approved') then
    raise exception 'edition document requires independent approval before completion';
  end if;
  return new;
end; $$;

create or replace function publish_edition_approval_event()
returns trigger language plpgsql as $$
declare event_name text; queued_id bigint;
begin
  event_name:=new.edition||'.'||new.doc_type||'.approval_'||new.approval_status;
  insert into integration_event(tenant_id,event_type,entity_id,payload)
  values(new.tenant_id,event_name,new.id,jsonb_build_object('eventType',event_name,'entityId',new.id,'documentNo',new.doc_no,'approvalStatus',new.approval_status))
  returning id into queued_id;
  insert into integration_delivery(tenant_id,event_id,connection_id)
  select new.tenant_id,queued_id,s.connection_id from integration_subscription s
  join integration_connection c on c.id=s.connection_id
  where s.tenant_id=new.tenant_id and s.event_type=event_name and s.is_active and c.is_active;
  return new;
end; $$;
create trigger edition_document_approval_event after update of approval_status on edition_document
for each row when(old.approval_status is distinct from new.approval_status)
execute function publish_edition_approval_event();

create table edition_resource (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(id) on delete cascade,
  edition text not null,
  resource_type text not null check(resource_type ~ '^[a-z][a-z0-9_]{1,39}$'),
  code text not null check(code ~ '^[A-Za-z0-9][A-Za-z0-9_./-]{0,39}$'),
  name text not null check(length(trim(name)) between 2 and 160),
  uom text not null check(length(trim(uom)) between 1 and 12),
  opening_qty numeric(16,3) not null default 0 check(opening_qty>=0),
  opening_value_paise bigint not null default 0 check(opening_value_paise>=0),
  payload jsonb not null default '{}'::jsonb check(jsonb_typeof(payload)='object'),
  is_active boolean not null default true,
  created_by uuid not null references app_user(id),
  updated_by uuid not null references app_user(id),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(tenant_id,edition,resource_type,code), unique(id,tenant_id),
  foreign key(tenant_id,edition) references tenant_edition(tenant_id,edition),
  constraint edition_resource_opening_sane check(opening_qty>0 or opening_value_paise=0)
);
create index edition_resource_list on edition_resource(tenant_id,edition,resource_type,is_active,code);
create index edition_resource_updated_by_fk on edition_resource(tenant_id,updated_by);

create table edition_resource_event (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references tenant(id) on delete cascade,
  resource_id uuid not null, event text not null check(event in ('created','updated')),
  before_data jsonb, after_data jsonb not null, actor_id uuid not null references app_user(id),
  occurred_at timestamptz not null default now(),
  foreign key(resource_id,tenant_id) references edition_resource(id,tenant_id)
);
create index edition_resource_event_resource_fk on edition_resource_event(tenant_id,resource_id,id);
create index edition_resource_event_actor_fk on edition_resource_event(tenant_id,actor_id);
create rule edition_resource_event_no_update as on update to edition_resource_event do instead nothing;
create rule edition_resource_event_no_delete as on delete to edition_resource_event do instead nothing;

create or replace function audit_edition_resource()
returns trigger language plpgsql as $$
declare event_name text; queued_id bigint;
begin
  event_name:=new.edition||'.resource.'||case when tg_op='INSERT' then 'created' else 'updated' end;
  insert into edition_resource_event(tenant_id,resource_id,event,before_data,after_data,actor_id)
  values(new.tenant_id,new.id,case when tg_op='INSERT' then 'created' else 'updated' end,
         case when tg_op='UPDATE' then to_jsonb(old) else null end,to_jsonb(new),new.updated_by);
  insert into integration_event(tenant_id,event_type,entity_id,payload)
  values(new.tenant_id,event_name,new.id,jsonb_build_object('eventType',event_name,'entityId',new.id,'edition',new.edition,'resourceType',new.resource_type,'code',new.code))
  returning id into queued_id;
  insert into integration_delivery(tenant_id,event_id,connection_id)
  select new.tenant_id,queued_id,s.connection_id from integration_subscription s
  join integration_connection c on c.id=s.connection_id
  where s.tenant_id=new.tenant_id and s.event_type=event_name and s.is_active and c.is_active;
  return new;
end; $$;
create trigger edition_resource_audit after insert or update on edition_resource
for each row execute function audit_edition_resource();

create table edition_document_line (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(id) on delete cascade,
  document_id uuid not null,
  resource_id uuid,
  line_kind text not null check(line_kind in (
    'receipt','produce','return_in','issue','consume','return_out',
    'labour','machine','freight','duty','overhead','subcontract','other')),
  description text not null check(length(trim(description)) between 1 and 240),
  quantity numeric(16,3) not null default 0 check(quantity>=0),
  uom text not null default '' check(length(uom)<=12),
  rate_paise bigint not null default 0 check(rate_paise>=0),
  amount_paise bigint not null default 0 check(amount_paise>=0),
  payload jsonb not null default '{}'::jsonb check(jsonb_typeof(payload)='object'),
  created_by uuid not null references app_user(id), created_at timestamptz not null default now(),
  unique(id,tenant_id),
  foreign key(document_id,tenant_id) references edition_document(id,tenant_id),
  foreign key(resource_id,tenant_id) references edition_resource(id,tenant_id),
  constraint edition_stock_line_resource check(
    line_kind not in ('receipt','produce','return_in','issue','consume','return_out')
    or (resource_id is not null and quantity>0))
);
create index edition_document_line_doc_fk on edition_document_line(tenant_id,document_id,id);
create index edition_document_line_resource_fk on edition_document_line(tenant_id,resource_id);

create table edition_stock_movement (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references tenant(id) on delete cascade,
  resource_id uuid not null,
  document_id uuid not null,
  document_line_id uuid not null,
  quantity_delta numeric(16,3) not null check(quantity_delta<>0),
  value_delta_paise bigint not null,
  occurred_at timestamptz not null default now(), actor_id uuid not null references app_user(id),
  foreign key(resource_id,tenant_id) references edition_resource(id,tenant_id),
  foreign key(document_id,tenant_id) references edition_document(id,tenant_id),
  foreign key(document_line_id,tenant_id) references edition_document_line(id,tenant_id),
  unique(tenant_id,document_line_id)
);
create index edition_stock_resource on edition_stock_movement(tenant_id,resource_id,id);
create index edition_stock_document_fk on edition_stock_movement(tenant_id,document_id);
create index edition_stock_actor_fk on edition_stock_movement(tenant_id,actor_id);
create rule edition_stock_movement_no_update as on update to edition_stock_movement do instead nothing;
create rule edition_stock_movement_no_delete as on delete to edition_stock_movement do instead nothing;

create or replace function guard_edition_line_write()
returns trigger language plpgsql as $$
declare document_status text; document_edition text; resource_edition text;
        target_document uuid; target_tenant uuid;
begin
  if tg_op='DELETE' then target_document:=old.document_id; target_tenant:=old.tenant_id;
  else target_document:=new.document_id; target_tenant:=new.tenant_id; end if;
  select status,edition into document_status,document_edition from edition_document
   where id=target_document and tenant_id=target_tenant;
  if document_status not in ('draft','in_progress') then
    raise exception 'edition lines can change only while the document is draft or active';
  end if;
  if tg_op<>'DELETE' and new.resource_id is not null then
    select edition into resource_edition from edition_resource
     where id=new.resource_id and tenant_id=new.tenant_id and is_active;
    if resource_edition is null then raise exception 'edition resource is not active'; end if;
    if resource_edition<>document_edition then raise exception 'resource belongs to a different edition'; end if;
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end; $$;
create trigger edition_line_write before insert or update or delete on edition_document_line
for each row execute function guard_edition_line_write();

create or replace function post_edition_stock()
returns trigger language plpgsql as $$
declare line record; effect numeric; available numeric; available_value bigint; movement_value bigint;
begin
  if old.status=new.status or new.status<>'completed' then return new; end if;
  for line in select * from edition_document_line where document_id=new.id order by id loop
    effect := case when line.line_kind in ('receipt','produce','return_in') then 1
                   when line.line_kind in ('issue','consume','return_out') then -1 else 0 end;
    if effect=0 then continue; end if;
    perform 1 from edition_resource where id=line.resource_id for update;
    select r.opening_qty+coalesce(sum(m.quantity_delta),0),
           r.opening_value_paise+coalesce(sum(m.value_delta_paise),0)
      into available,available_value
      from edition_resource r left join edition_stock_movement m on m.resource_id=r.id
     where r.id=line.resource_id group by r.opening_qty,r.opening_value_paise;
    if effect<0 and available<line.quantity then
      raise exception 'insufficient edition stock for %: available %, required %',line.description,available,line.quantity;
    end if;
    movement_value := case when effect>0 then line.amount_paise
                           when line.quantity=available then -available_value
                           else -round((available_value::numeric/available::numeric)*line.quantity)::bigint end;
    insert into edition_stock_movement(
      tenant_id,resource_id,document_id,document_line_id,quantity_delta,value_delta_paise,actor_id)
    values(new.tenant_id,line.resource_id,new.id,line.id,line.quantity*effect,movement_value,new.updated_by);
  end loop;
  return new;
end; $$;
create trigger edition_document_post_stock after update of status on edition_document
for each row execute function post_edition_stock();

create view v_edition_stock as
select r.tenant_id,r.id resource_id,r.edition,r.resource_type,r.code,r.name,r.uom,r.is_active,
       r.opening_qty+coalesce(sum(m.quantity_delta),0) quantity,
       r.opening_value_paise+coalesce(sum(m.value_delta_paise),0) value_paise,
       case when r.opening_qty+coalesce(sum(m.quantity_delta),0)=0 then 0
            else round((r.opening_value_paise+coalesce(sum(m.value_delta_paise),0))::numeric/
                 (r.opening_qty+coalesce(sum(m.quantity_delta),0))::numeric) end average_rate_paise
  from edition_resource r left join edition_stock_movement m on m.resource_id=r.id
 where r.tenant_id=current_setting('app.tenant_id',true)::uuid
 group by r.id;

create view v_edition_job_cost as
select d.tenant_id,d.id document_id,d.edition,d.doc_type,d.doc_no,d.doc_date,d.status,
       coalesce(stock.material_paise,planned.material_paise,0)::bigint material_paise,
       coalesce(cost.labour_paise,0)::bigint labour_paise,
       coalesce(cost.machine_paise,0)::bigint machine_paise,
       coalesce(cost.logistics_duty_paise,0)::bigint logistics_duty_paise,
       coalesce(cost.other_paise,0)::bigint other_paise,
       (coalesce(stock.material_paise,planned.material_paise,0)+coalesce(cost.labour_paise,0)+
        coalesce(cost.machine_paise,0)+coalesce(cost.logistics_duty_paise,0)+coalesce(cost.other_paise,0))::bigint total_cost_paise
  from edition_document d
  left join lateral (select sum(-value_delta_paise)::bigint material_paise from edition_stock_movement where document_id=d.id and quantity_delta<0) stock on true
  left join lateral (select sum(amount_paise)::bigint material_paise from edition_document_line where document_id=d.id and line_kind in ('issue','consume','return_out')) planned on true
  left join lateral (select
      sum(amount_paise) filter(where line_kind='labour')::bigint labour_paise,
      sum(amount_paise) filter(where line_kind='machine')::bigint machine_paise,
      sum(amount_paise) filter(where line_kind in ('freight','duty'))::bigint logistics_duty_paise,
      sum(amount_paise) filter(where line_kind in ('overhead','subcontract','other'))::bigint other_paise
    from edition_document_line where document_id=d.id) cost on true
 where d.tenant_id=current_setting('app.tenant_id',true)::uuid;

alter table custom_field_definition drop constraint custom_field_definition_entity_type_check;
alter table custom_field_definition add constraint custom_field_definition_entity_type_check check(entity_type in (
  'ledger_account','piece','grey_purchase_order','finish_sales_order','sales_invoice',
  'purchase_invoice','payment','location_transfer','edition_document','edition_resource'));

alter table edition_resource enable row level security; alter table edition_resource force row level security;
alter table edition_resource_event enable row level security; alter table edition_resource_event force row level security;
alter table edition_document_line enable row level security; alter table edition_document_line force row level security;
alter table edition_stock_movement enable row level security; alter table edition_stock_movement force row level security;
create policy tenant_isolation on edition_resource using(tenant_id=current_setting('app.tenant_id',true)::uuid) with check(tenant_id=current_setting('app.tenant_id',true)::uuid);
create policy tenant_isolation on edition_resource_event using(tenant_id=current_setting('app.tenant_id',true)::uuid) with check(tenant_id=current_setting('app.tenant_id',true)::uuid);
create policy tenant_isolation on edition_document_line using(tenant_id=current_setting('app.tenant_id',true)::uuid) with check(tenant_id=current_setting('app.tenant_id',true)::uuid);
create policy tenant_isolation on edition_stock_movement using(tenant_id=current_setting('app.tenant_id',true)::uuid) with check(tenant_id=current_setting('app.tenant_id',true)::uuid);
grant select,insert,update on edition_resource to link_erp_app;
grant select,insert on edition_resource_event to link_erp_app;
grant select,insert,update,delete on edition_document_line to link_erp_app;
grant select,insert on edition_stock_movement to link_erp_app;
grant select on v_edition_stock,v_edition_job_cost to link_erp_app;
grant usage,select on all sequences in schema public to link_erp_app;
