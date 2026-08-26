-- Shared customization, reporting and integration platform. Definitions are
-- tenant-owned data; report SQL stays server allow-listed, and integrations
-- consume an idempotent pull feed instead of giving the ERP arbitrary URLs.

create table custom_field_definition (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(id) on delete cascade,
  entity_type text not null check (entity_type in (
    'ledger_account','piece','grey_purchase_order','finish_sales_order',
    'sales_invoice','purchase_invoice','payment','location_transfer')),
  field_key text not null check (field_key ~ '^[a-z][a-z0-9_]{1,39}$'),
  label text not null check (length(label) between 2 and 80),
  data_type text not null check (data_type in ('text','number','date','boolean','choice','multi_choice')),
  help_text text not null default '' check (length(help_text) <= 300),
  required boolean not null default false,
  choices jsonb not null default '[]'::jsonb check (jsonb_typeof(choices)='array'),
  sort_order smallint not null default 0,
  is_active boolean not null default true,
  created_by uuid not null references app_user(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id,entity_type,field_key), unique (id,tenant_id)
);
create index custom_field_definition_actor_fk on custom_field_definition(tenant_id,created_by);
create index custom_field_definition_entity on custom_field_definition(tenant_id,entity_type,is_active,sort_order);

create table custom_field_value (
  tenant_id uuid not null references tenant(id) on delete cascade,
  definition_id uuid not null, entity_id uuid not null, value jsonb not null,
  updated_by uuid not null references app_user(id), updated_at timestamptz not null default now(),
  primary key (tenant_id,definition_id,entity_id),
  foreign key (definition_id,tenant_id) references custom_field_definition(id,tenant_id)
);
create index custom_field_value_entity on custom_field_value(tenant_id,entity_id,definition_id);
create index custom_field_value_actor_fk on custom_field_value(tenant_id,updated_by);

create or replace function validate_custom_field_value()
returns trigger language plpgsql as $$
declare d custom_field_definition%rowtype;
begin
  select * into d from custom_field_definition where id=new.definition_id and tenant_id=new.tenant_id and is_active;
  if not found then raise exception 'custom field is not active for this company'; end if;
  if d.data_type='text' and jsonb_typeof(new.value)<>'string' then raise exception 'custom field % expects text',d.label;
  elsif d.data_type='number' and jsonb_typeof(new.value)<>'number' then raise exception 'custom field % expects a number',d.label;
  elsif d.data_type='boolean' and jsonb_typeof(new.value)<>'boolean' then raise exception 'custom field % expects yes/no',d.label;
  elsif d.data_type='date' and (jsonb_typeof(new.value)<>'string' or new.value#>>'{}' !~ '^\d{4}-\d{2}-\d{2}$') then raise exception 'custom field % expects YYYY-MM-DD',d.label;
  elsif d.data_type='choice' and (jsonb_typeof(new.value)<>'string' or not d.choices ? (new.value#>>'{}')) then raise exception 'custom field % is not an allowed choice',d.label;
  elsif d.data_type='multi_choice' and (jsonb_typeof(new.value)<>'array' or exists(select 1 from jsonb_array_elements_text(new.value) x where not d.choices ? x)) then raise exception 'custom field % contains an invalid choice',d.label;
  end if;
  return new;
end; $$;
create trigger custom_field_value_validate before insert or update on custom_field_value
for each row execute function validate_custom_field_value();

create table custom_report_definition (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenant(id) on delete cascade,
  name text not null check (length(name) between 2 and 100), description text not null default '' check (length(description)<=500),
  source_key text not null check (length(source_key) between 2 and 60),
  columns jsonb not null check (jsonb_typeof(columns)='array' and jsonb_array_length(columns)>0),
  filters jsonb not null default '[]'::jsonb check (jsonb_typeof(filters)='array'),
  sort_spec jsonb not null default '{}'::jsonb check (jsonb_typeof(sort_spec)='object'),
  is_shared boolean not null default false, is_active boolean not null default true,
  created_by uuid not null references app_user(id), created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (tenant_id,name), unique (id,tenant_id)
);
create index custom_report_definition_actor_fk on custom_report_definition(tenant_id,created_by);
create index custom_report_definition_list on custom_report_definition(tenant_id,is_active,name);

create table integration_connection (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenant(id) on delete cascade,
  name text not null check (length(name) between 2 and 100),
  adapter text not null check (adapter in ('pull_api','tally','file_exchange','custom')),
  description text not null default '' check (length(description)<=500),
  token_hash char(64) not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  token_prefix text not null check (length(token_prefix)=12), is_active boolean not null default true,
  created_by uuid not null references app_user(id), created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (tenant_id,name), unique (id,tenant_id)
);
create index integration_connection_actor_fk on integration_connection(tenant_id,created_by);
create table integration_subscription (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenant(id) on delete cascade,
  connection_id uuid not null, event_type text not null check (event_type ~ '^[a-z][a-z0-9_.]{2,79}$'),
  is_active boolean not null default true, created_at timestamptz not null default now(),
  unique (tenant_id,connection_id,event_type),
  foreign key (connection_id,tenant_id) references integration_connection(id,tenant_id)
);
create index integration_subscription_connection on integration_subscription(tenant_id,connection_id,is_active);

create table integration_event (
  id bigint generated always as identity primary key, tenant_id uuid not null references tenant(id) on delete cascade,
  event_key uuid not null default gen_random_uuid(), event_type text not null, entity_id uuid not null,
  payload jsonb not null check (jsonb_typeof(payload)='object'), occurred_at timestamptz not null default now(),
  unique (tenant_id,event_key), unique (id,tenant_id)
);
create index integration_event_timeline on integration_event(tenant_id,id desc);
create table integration_delivery (
  id bigint generated always as identity primary key, tenant_id uuid not null references tenant(id) on delete cascade,
  event_id bigint not null, connection_id uuid not null,
  status text not null default 'pending' check (status in ('pending','delivered','failed','cancelled')),
  attempts integer not null default 0 check (attempts between 0 and 100), last_error text,
  delivered_at timestamptz, updated_at timestamptz not null default now(),
  unique (tenant_id,event_id,connection_id),
  foreign key (event_id,tenant_id) references integration_event(id,tenant_id),
  foreign key (connection_id,tenant_id) references integration_connection(id,tenant_id),
  constraint integration_delivery_complete check ((status='delivered')=(delivered_at is not null))
);
create index integration_delivery_feed on integration_delivery(tenant_id,connection_id,status,id);

create table platform_change_event (
  id bigint generated always as identity primary key, tenant_id uuid not null references tenant(id) on delete cascade,
  area text not null check (area in ('custom_field','custom_report','integration')),
  target_id uuid not null, action text not null, before_data jsonb, after_data jsonb,
  actor_id uuid not null references app_user(id), occurred_at timestamptz not null default now()
);
create index platform_change_timeline on platform_change_event(tenant_id,id desc);
create index platform_change_actor_fk on platform_change_event(tenant_id,actor_id);
create rule platform_change_no_update as on update to platform_change_event do instead nothing;
create rule platform_change_no_delete as on delete to platform_change_event do instead nothing;
create rule integration_event_no_update as on update to integration_event do instead nothing;
create rule integration_event_no_delete as on delete to integration_event do instead nothing;

create or replace function queue_platform_event()
returns trigger language plpgsql as $$
declare event_name text := tg_argv[0]; queued_id bigint;
begin
  if tg_op='UPDATE' then event_name := event_name||'.'||lower(new.status::text); end if;
  insert into integration_event(tenant_id,event_type,entity_id,payload)
  values(new.tenant_id,event_name,new.id,jsonb_build_object('eventType',event_name,'entityId',new.id,'status',coalesce(to_jsonb(new)->>'status','created')))
  returning id into queued_id;
  insert into integration_delivery(tenant_id,event_id,connection_id)
  select new.tenant_id,queued_id,s.connection_id from integration_subscription s
  join integration_connection c on c.id=s.connection_id
  where s.tenant_id=new.tenant_id and s.event_type=event_name and s.is_active and c.is_active;
  return new;
end; $$;
create trigger platform_sales_invoice_created after insert on sales_invoice for each row execute function queue_platform_event('sales_invoice.created');
create trigger platform_sales_invoice_status after update of status on sales_invoice for each row when (old.status is distinct from new.status) execute function queue_platform_event('sales_invoice');
create trigger platform_purchase_invoice_created after insert on purchase_invoice for each row execute function queue_platform_event('purchase_invoice.created');
create trigger platform_purchase_invoice_status after update of status on purchase_invoice for each row when (old.status is distinct from new.status) execute function queue_platform_event('purchase_invoice');
create trigger platform_payment_created after insert on payment for each row execute function queue_platform_event('payment.created');
create trigger platform_payment_status after update of status on payment for each row when (old.status is distinct from new.status) execute function queue_platform_event('payment');
create trigger platform_transfer_created after insert on location_transfer for each row execute function queue_platform_event('location_transfer.created');
create trigger platform_transfer_status after update of status on location_transfer for each row when (old.status is distinct from new.status) execute function queue_platform_event('location_transfer');
create trigger platform_opening_stock_created after insert on opening_stock_batch for each row execute function queue_platform_event('opening_stock.created');

create or replace function authenticate_integration_feed(p_token_hash text)
returns table(tenant_id uuid,connection_id uuid)
language sql stable security definer set search_path=public,pg_temp as $$
  select c.tenant_id,c.id from integration_connection c where c.token_hash=p_token_hash and c.is_active limit 1
$$;
revoke all on function authenticate_integration_feed(text) from public;
grant execute on function authenticate_integration_feed(text) to link_erp_app;

alter table custom_field_definition enable row level security; alter table custom_field_definition force row level security;
alter table custom_field_value enable row level security; alter table custom_field_value force row level security;
alter table custom_report_definition enable row level security; alter table custom_report_definition force row level security;
alter table integration_connection enable row level security; alter table integration_connection force row level security;
alter table integration_subscription enable row level security; alter table integration_subscription force row level security;
alter table integration_event enable row level security; alter table integration_event force row level security;
alter table integration_delivery enable row level security; alter table integration_delivery force row level security;
alter table platform_change_event enable row level security; alter table platform_change_event force row level security;
create policy tenant_isolation on custom_field_definition using (tenant_id=current_setting('app.tenant_id',true)::uuid) with check (tenant_id=current_setting('app.tenant_id',true)::uuid);
create policy tenant_isolation on custom_field_value using (tenant_id=current_setting('app.tenant_id',true)::uuid) with check (tenant_id=current_setting('app.tenant_id',true)::uuid);
create policy tenant_isolation on custom_report_definition using (tenant_id=current_setting('app.tenant_id',true)::uuid) with check (tenant_id=current_setting('app.tenant_id',true)::uuid);
create policy tenant_isolation on integration_connection using (tenant_id=current_setting('app.tenant_id',true)::uuid) with check (tenant_id=current_setting('app.tenant_id',true)::uuid);
create policy tenant_isolation on integration_subscription using (tenant_id=current_setting('app.tenant_id',true)::uuid) with check (tenant_id=current_setting('app.tenant_id',true)::uuid);
create policy tenant_isolation on integration_event using (tenant_id=current_setting('app.tenant_id',true)::uuid) with check (tenant_id=current_setting('app.tenant_id',true)::uuid);
create policy tenant_isolation on integration_delivery using (tenant_id=current_setting('app.tenant_id',true)::uuid) with check (tenant_id=current_setting('app.tenant_id',true)::uuid);
create policy tenant_isolation on platform_change_event using (tenant_id=current_setting('app.tenant_id',true)::uuid) with check (tenant_id=current_setting('app.tenant_id',true)::uuid);
grant select,insert,update on custom_field_definition,custom_field_value,custom_report_definition,integration_connection,integration_subscription,integration_delivery to link_erp_app;
grant select,insert on integration_event,platform_change_event to link_erp_app;
grant usage,select on all sequences in schema public to link_erp_app;
