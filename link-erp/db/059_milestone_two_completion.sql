-- Milestone-two completion: document evidence attachments. Binary evidence is
-- kept with the tenant's transactional backup, deduplicated by SHA-256, and
-- never physically deleted. Removal is a status/event, not data destruction.

create table document_attachment (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenant(id) on delete cascade,
  doc_type        text not null check (doc_type in (
    'sales_invoice','purchase_invoice','payment','grey_inward','dyeing_issue',
    'dyeing_receipt','dispatch','opening_stock','location_transfer'
  )),
  doc_id          uuid not null,
  file_name       text not null check (length(file_name) between 1 and 180),
  content_type    text not null check (content_type in ('application/pdf','image/jpeg','image/png')),
  byte_size       integer not null check (byte_size between 1 and 5242880),
  sha256          char(64) not null check (sha256 ~ '^[0-9a-f]{64}$'),
  content         bytea not null,
  note            text not null default '' check (length(note) <= 500),
  status          text not null default 'active' check (status in ('active','removed')),
  created_by      uuid not null references app_user(id),
  created_at      timestamptz not null default now(),
  removed_by      uuid references app_user(id),
  removed_at      timestamptz,
  removal_reason  text,
  unique (id,tenant_id),
  constraint attachment_bytes_match check (octet_length(content)=byte_size),
  constraint attachment_removal_complete check (
    (status='removed')=(removed_by is not null and removed_at is not null and removal_reason is not null)
  )
);
create unique index document_attachment_live_hash
  on document_attachment(tenant_id,doc_type,doc_id,sha256) where status='active';
create index document_attachment_by_document
  on document_attachment(tenant_id,doc_type,doc_id,created_at desc);
create index document_attachment_created_by_fk on document_attachment(tenant_id,created_by);
create index document_attachment_removed_by_fk on document_attachment(tenant_id,removed_by)
  where removed_by is not null;

create table document_attachment_event (
  id              bigint generated always as identity primary key,
  tenant_id       uuid not null references tenant(id) on delete cascade,
  attachment_id   uuid not null,
  event           text not null check (event in ('added','removed')),
  reason          text not null default '',
  actor_id        uuid not null references app_user(id),
  occurred_at     timestamptz not null default now(),
  foreign key (attachment_id,tenant_id) references document_attachment(id,tenant_id)
);
create index attachment_event_attachment_fk
  on document_attachment_event(tenant_id,attachment_id,id);
create index attachment_event_actor_fk on document_attachment_event(tenant_id,actor_id);

create rule attachment_no_delete as on delete to document_attachment do instead nothing;
create rule attachment_event_no_update as on update to document_attachment_event do instead nothing;
create rule attachment_event_no_delete as on delete to document_attachment_event do instead nothing;

alter table document_attachment enable row level security;
alter table document_attachment force row level security;
create policy tenant_isolation on document_attachment
  using (tenant_id=current_setting('app.tenant_id',true)::uuid)
  with check (tenant_id=current_setting('app.tenant_id',true)::uuid);

alter table document_attachment_event enable row level security;
alter table document_attachment_event force row level security;
create policy tenant_isolation on document_attachment_event
  using (tenant_id=current_setting('app.tenant_id',true)::uuid)
  with check (tenant_id=current_setting('app.tenant_id',true)::uuid);

grant select,insert,update on document_attachment to link_erp_app;
grant select,insert on document_attachment_event to link_erp_app;
grant usage,select on all sequences in schema public to link_erp_app;
