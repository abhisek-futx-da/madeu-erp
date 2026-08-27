-- Emailing a document from the document.
--
-- Every screen in the incumbent carries E-Mail on its toolbar, and that is how
-- a challan actually reaches a buyer in this trade. Here a document could be
-- printed and nothing else: somebody downloaded a PDF, opened their own mail
-- client, found the party's address, and attached it by hand.
--
-- Delivery never runs inside the transaction that made the document. The
-- document commits, a row lands here, and a worker sends it — the same shape
-- as the WhatsApp outbox in 054, for the same reason: a mail server that is
-- slow or down must not be able to roll back an invoice.

alter table ledger_account add column if not exists email citext;
alter table ledger_account drop constraint if exists ledger_email_shape;
alter table ledger_account add constraint ledger_email_shape
  check (email is null or email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$');

create type email_state as enum ('pending', 'sending', 'sent', 'failed', 'cancelled');

create table document_email (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenant(id) on delete cascade,
  doc_type        text not null,
  doc_id          uuid not null,
  to_email        citext not null,
  to_name         text not null default '',
  cc_email        citext,
  subject         text not null,
  body            text not null,
  /** Rendered when the worker sends, not now: a document can be revised. */
  attachment_name text not null,
  state           email_state not null default 'pending',
  attempts        smallint not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error      text,
  queued_by       uuid references app_user(id),
  created_at      timestamptz not null default now(),
  sent_at         timestamptz,
  constraint email_doc_type_known check (
    doc_type in ('sales_invoice', 'delivery_challan', 'party_statement',
                 'ledger_confirmation', 'purchase_order', 'packing_list')
  ),
  constraint email_attempts_sane check (attempts between 0 and 20),
  constraint email_to_shape check (to_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')
);

create index document_email_due on document_email (next_attempt_at, id)
  where state in ('pending', 'failed');
create index document_email_by_doc on document_email (tenant_id, doc_type, doc_id);
create index document_email_by_state on document_email (tenant_id, state, created_at desc);
create index document_email_by_user on document_email (queued_by) where queued_by is not null;

alter table document_email enable row level security;
alter table document_email force row level security;
drop policy if exists tenant_isolation on document_email;
create policy tenant_isolation on document_email
  using (tenant_id = current_setting('app.tenant_id', true)::uuid)
  with check (tenant_id = current_setting('app.tenant_id', true)::uuid);

grant select, insert, update on document_email to link_erp_app;

create or replace view v_document_email as
select e.tenant_id, e.id, e.doc_type, e.doc_id, e.to_email, e.to_name,
       e.subject, e.attachment_name, e.state::text as state, e.attempts,
       e.last_error, e.created_at, e.sent_at, u.full_name as queued_by
  from document_email e
  left join app_user u on u.id = e.queued_by
 where e.tenant_id = current_setting('app.tenant_id', true)::uuid;

grant select on v_document_email to link_erp_app;

/**
 * The queue as an operator reads it: what is waiting, what failed and why.
 * A mail that has been pending for hours means the sender is not configured
 * or cannot reach the server, and that has to be visible rather than silent.
 */
create or replace view v_email_queue_health as
select tenant_id,
       count(*) filter (where state = 'pending')::int  as pending,
       count(*) filter (where state = 'failed')::int   as failed,
       count(*) filter (where state = 'sent')::int     as sent,
       min(created_at) filter (where state in ('pending', 'failed')) as oldest_waiting
  from document_email
 where tenant_id = current_setting('app.tenant_id', true)::uuid
 group by tenant_id;

grant select on v_email_queue_health to link_erp_app;
