-- Provider calls never run inside a stock/accounting transaction.  Documents
-- commit first, then an idempotent outbox worker delivers WhatsApp messages.

alter table ledger_account add column if not exists mobile_e164 text;
alter table ledger_account drop constraint if exists ledger_mobile_e164;
alter table ledger_account add constraint ledger_mobile_e164 check (
  mobile_e164 is null or mobile_e164 ~ '^\+[1-9][0-9]{7,14}$'
);

create type notification_kind as enum (
  'invoice','packing_list','dispatch','payment_reminder','party_statement'
);
create type notification_state as enum ('pending','sending','sent','failed','cancelled');

create table notification_outbox (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenant(id) on delete cascade,
  kind            notification_kind not null,
  recipient_name  text not null,
  phone_e164      text not null,
  template_name   text not null,
  payload         jsonb not null,
  source_doc      text not null,
  source_id       uuid not null,
  state           notification_state not null default 'pending',
  attempts        smallint not null default 0,
  next_attempt_at timestamptz not null default now(),
  provider_id     text,
  last_error      text,
  created_at      timestamptz not null default now(),
  sent_at         timestamptz,
  unique (tenant_id, kind, source_doc, source_id, phone_e164),
  constraint notification_phone_e164 check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  constraint notification_attempts_sane check (attempts between 0 and 20)
);
create index notification_due on notification_outbox(next_attempt_at, id)
  where state in ('pending','failed');

alter table notification_outbox enable row level security;
alter table notification_outbox force row level security;
create policy tenant_isolation on notification_outbox
  using (tenant_id=current_setting('app.tenant_id', true)::uuid)
  with check (tenant_id=current_setting('app.tenant_id', true)::uuid);
grant select, insert, update, delete on notification_outbox to link_erp_app;
