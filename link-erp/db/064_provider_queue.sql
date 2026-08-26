-- A durable queue for statutory submissions, and the history of every attempt.
--
-- Until now a submission was one synchronous call. If the portal was slow, the
-- clerk saw a spinner; if it timed out after the IRP had already registered the
-- invoice, pressing the button again would try to register it twice; and the
-- only record of what went wrong was a single `last_error` column that the next
-- attempt overwrote. None of that is good enough for a document with a legal
-- consequence.
--
-- Three properties matter and none of them are about speed:
--
--   * An attempt is idempotent. The key is derived from the document, so a
--     retry after an ambiguous timeout asks about the same submission rather
--     than creating a second one.
--   * Every attempt is kept. When a mill's accountant asks why an invoice has
--     no IRN, the answer is a list of what was tried and what came back — not
--     one overwritten string.
--   * Failure is visible and bounded. A submission backs off, gives up after a
--     stated number of attempts, and sits in a queue a person can see, rather
--     than retrying silently forever or disappearing.
--
-- Nothing here talks to a government portal. It is the machinery around a
-- provider call; whether a real provider ever accepts a payload is recorded in
-- docs/GSP_IRP_READINESS.md and is not claimed by this file.

create type submission_state as enum (
  'queued',      -- waiting for its turn, or for its backoff to expire
  'in_flight',   -- a worker has claimed it
  'succeeded',
  'failed',      -- the last attempt failed; it will be tried again
  'abandoned',   -- out of attempts, or cancelled by a person
  'cancelled'
);

create table provider_submission (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenant(id) on delete cascade,
  /** `einvoice` or `eway`; free text so a new provider is a row, not a migration. */
  channel         text not null,
  action          text not null default 'generate',
  doc_type        text not null,
  doc_id          uuid not null,
  /**
   * Derived from the document, never random: the whole point is that asking
   * twice about the same invoice is the same question.
   */
  idempotency_key text not null,
  state           submission_state not null default 'queued',
  attempts        smallint not null default 0,
  max_attempts    smallint not null default 5,
  next_attempt_at timestamptz not null default now(),
  claimed_at      timestamptz,
  last_code       text,
  last_error      text,
  succeeded_at    timestamptz,
  created_at      timestamptz not null default now(),
  created_by      uuid references app_user(id),
  unique (tenant_id, idempotency_key),
  constraint submission_attempts_sane check (attempts >= 0 and max_attempts between 1 and 20)
);

create index submission_due
  on provider_submission (next_attempt_at)
  where state in ('queued', 'failed');
create index submission_by_doc on provider_submission (tenant_id, doc_type, doc_id);
create index submission_by_creator on provider_submission (created_by);

/**
 * Append-only. This is the answer to "what did you actually send, and what came
 * back", which is the only question worth asking when a return is disputed.
 */
create table provider_attempt (
  id             bigserial primary key,
  tenant_id      uuid not null references tenant(id) on delete cascade,
  submission_id  uuid not null references provider_submission(id) on delete cascade,
  attempt_no     smallint not null,
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  outcome        text not null,
  code           text,
  message        text,
  http_status    smallint,
  constraint attempt_outcome check (outcome in ('succeeded', 'failed', 'skipped')),
  unique (submission_id, attempt_no)
);
create index attempt_by_submission on provider_attempt (submission_id, attempt_no);
create index attempt_by_tenant on provider_attempt (tenant_id);

create rule provider_attempt_no_update as on update to provider_attempt do instead nothing;
create rule provider_attempt_no_delete as on delete to provider_attempt do instead nothing;

/** What an operator sees: one row per submission, newest trouble first. */
create view v_provider_queue as
select s.tenant_id, s.id as submission_id, s.channel, s.action, s.doc_type, s.doc_id,
       s.state::text as state, s.attempts, s.max_attempts, s.next_attempt_at,
       s.last_code, s.last_error, s.succeeded_at, s.created_at,
       coalesce(i.invoice_no, d.challan_no) as doc_no,
       coalesce(p.name, cust.name) as party,
       g.irn, g.filing_status,
       (select count(*)::int from provider_attempt a where a.submission_id = s.id) as tries,
       (select max(a.finished_at) from provider_attempt a where a.submission_id = s.id) as last_try
  from provider_submission s
  left join sales_invoice i on i.id = s.doc_id and s.doc_type = 'sales_invoice'
  left join ledger_account p on p.id = i.party_id
  left join dispatch d on d.id = s.doc_id and s.doc_type = 'dispatch'
  left join ledger_account cust on cust.id = d.party_id
  left join gst_document g on g.invoice_id = i.id
 where s.tenant_id = current_setting('app.tenant_id', true)::uuid;

create view v_provider_attempt as
select a.tenant_id, a.submission_id, a.attempt_no, a.started_at, a.finished_at,
       a.outcome, a.code, a.message, a.http_status
  from provider_attempt a
 where a.tenant_id = current_setting('app.tenant_id', true)::uuid;

do $$
declare t text;
begin
  foreach t in array array['provider_submission', 'provider_attempt'] loop
    execute format('grant select, insert, update, delete on %I to link_erp_app', t);
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format(
      'create policy tenant_isolation on %I using (tenant_id = current_setting(''app.tenant_id'', true)::uuid)'
      || ' with check (tenant_id = current_setting(''app.tenant_id'', true)::uuid)', t);
  end loop;
end $$;

grant usage, select on sequence provider_attempt_id_seq to link_erp_app;
grant select on v_provider_queue, v_provider_attempt to link_erp_app;
