-- Five parallel textile editions on one audited document engine. Edition-
-- specific payloads are validated by the API; lifecycle, tenant isolation,
-- evidence, numbering and events are enforced here for every edition.

create table tenant_edition (
  tenant_id uuid not null references tenant(id) on delete cascade,
  edition text not null check (edition in ('weaving','dyeing','exports','logistics','garments')),
  is_enabled boolean not null default true,
  config jsonb not null default '{}'::jsonb check (jsonb_typeof(config)='object'),
  activated_by uuid references app_user(id), activated_at timestamptz not null default now(),
  updated_at timestamptz not null default now(), primary key(tenant_id,edition)
);
create index tenant_edition_actor_fk on tenant_edition(tenant_id,activated_by);
insert into tenant_edition(tenant_id,edition)
select t.id,e.edition from tenant t cross join (values('weaving'),('dyeing'),('exports'),('logistics'),('garments')) e(edition)
on conflict do nothing;
create or replace function provision_tenant_editions()
returns trigger language plpgsql as $$
begin
  insert into tenant_edition(tenant_id,edition)
  select new.id,x from unnest(array['weaving','dyeing','exports','logistics','garments']) x;
  return new;
end; $$;
create trigger tenant_provision_editions after insert on tenant
for each row execute function provision_tenant_editions();

create table edition_document (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(id) on delete cascade,
  edition text not null, doc_type text not null, doc_no text not null,
  doc_date date not null, party_id uuid,
  business_location_id uuid, status text not null default 'draft'
    check (status in ('draft','in_progress','held','completed','cancelled')),
  payload jsonb not null check (jsonb_typeof(payload)='object'),
  remarks text not null default '' check (length(remarks)<=1000),
  created_by uuid not null references app_user(id), updated_by uuid not null references app_user(id),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  completed_by uuid references app_user(id), completed_at timestamptz,
  cancelled_by uuid references app_user(id), cancelled_at timestamptz, cancellation_reason text,
  unique(tenant_id,doc_no), unique(id,tenant_id),
  foreign key(tenant_id,edition) references tenant_edition(tenant_id,edition),
  foreign key(party_id,tenant_id) references ledger_account(id,tenant_id),
  foreign key(business_location_id,tenant_id) references business_location(id,tenant_id),
  constraint edition_document_completion check ((status='completed')=(completed_by is not null and completed_at is not null)),
  constraint edition_document_cancellation check ((status='cancelled')=(cancelled_by is not null and cancelled_at is not null and cancellation_reason is not null))
);
create index edition_document_list on edition_document(tenant_id,edition,doc_type,doc_date desc,id);
create index edition_document_party_fk on edition_document(tenant_id,party_id);
create index edition_document_location_fk on edition_document(tenant_id,business_location_id);
create index edition_document_updated_by_fk on edition_document(tenant_id,updated_by);
create index edition_document_completed_by_fk on edition_document(tenant_id,completed_by);
create index edition_document_cancelled_by_fk on edition_document(tenant_id,cancelled_by);

create table edition_document_event (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references tenant(id) on delete cascade,
  document_id uuid not null, event text not null, from_status text, to_status text,
  details jsonb not null default '{}'::jsonb, actor_id uuid not null references app_user(id),
  occurred_at timestamptz not null default now(),
  foreign key(document_id,tenant_id) references edition_document(id,tenant_id)
);
create index edition_document_event_document_fk on edition_document_event(tenant_id,document_id,id);
create index edition_document_event_actor_fk on edition_document_event(tenant_id,actor_id);
create rule edition_document_event_no_update as on update to edition_document_event do instead nothing;
create rule edition_document_event_no_delete as on delete to edition_document_event do instead nothing;

create or replace function guard_edition_document_transition()
returns trigger language plpgsql as $$
begin
  if old.status=new.status then return new; end if;
  if not ((old.status='draft' and new.status in ('in_progress','cancelled')) or
          (old.status='in_progress' and new.status in ('held','completed','cancelled')) or
          (old.status='held' and new.status in ('in_progress','cancelled'))) then
    raise exception 'edition document cannot move from % to %',old.status,new.status;
  end if;
  return new;
end; $$;
create trigger edition_document_transition before update of status on edition_document
for each row execute function guard_edition_document_transition();

create or replace function publish_edition_event()
returns trigger language plpgsql as $$
declare event_name text; queued_id bigint;
begin
  event_name := new.edition||'.'||new.doc_type||'.'||case when tg_op='INSERT' then 'created' else new.status end;
  insert into integration_event(tenant_id,event_type,entity_id,payload)
  values(new.tenant_id,event_name,new.id,jsonb_build_object('eventType',event_name,'entityId',new.id,'documentNo',new.doc_no,'edition',new.edition,'documentType',new.doc_type,'status',new.status))
  returning id into queued_id;
  insert into integration_delivery(tenant_id,event_id,connection_id)
  select new.tenant_id,queued_id,s.connection_id from integration_subscription s
  join integration_connection c on c.id=s.connection_id
  where s.tenant_id=new.tenant_id and s.event_type=event_name and s.is_active and c.is_active;
  return new;
end; $$;
create trigger edition_document_created after insert on edition_document for each row execute function publish_edition_event();
create trigger edition_document_status_event after update of status on edition_document
for each row when(old.status is distinct from new.status) execute function publish_edition_event();

alter table document_attachment drop constraint document_attachment_doc_type_check;
alter table document_attachment add constraint document_attachment_doc_type_check check (doc_type in (
  'sales_invoice','purchase_invoice','payment','grey_inward','dyeing_issue','dyeing_receipt',
  'dispatch','opening_stock','location_transfer','edition_document'));
alter table custom_field_definition drop constraint custom_field_definition_entity_type_check;
alter table custom_field_definition add constraint custom_field_definition_entity_type_check check (entity_type in (
  'ledger_account','piece','grey_purchase_order','finish_sales_order','sales_invoice',
  'purchase_invoice','payment','location_transfer','edition_document'));

alter table tenant_edition enable row level security; alter table tenant_edition force row level security;
alter table edition_document enable row level security; alter table edition_document force row level security;
alter table edition_document_event enable row level security; alter table edition_document_event force row level security;
create policy tenant_isolation on tenant_edition using(tenant_id=current_setting('app.tenant_id',true)::uuid) with check(tenant_id=current_setting('app.tenant_id',true)::uuid);
create policy tenant_isolation on edition_document using(tenant_id=current_setting('app.tenant_id',true)::uuid) with check(tenant_id=current_setting('app.tenant_id',true)::uuid);
create policy tenant_isolation on edition_document_event using(tenant_id=current_setting('app.tenant_id',true)::uuid) with check(tenant_id=current_setting('app.tenant_id',true)::uuid);
grant select,insert,update on tenant_edition,edition_document to link_erp_app;
grant select,insert on edition_document_event to link_erp_app;
grant usage,select on all sequences in schema public to link_erp_app;
