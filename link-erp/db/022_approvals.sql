-- Maker–checker approval.
--
-- Until now anyone holding the write role for an area could post a document of
-- any value on their own: a sales clerk could raise a fifty-lakh invoice and
-- nobody else would ever see it. A mill wants a second pair of eyes above a
-- figure it chooses, and wants it enforced rather than agreed verbally.
--
-- A document over the threshold is created but *not posted*: its accounting
-- entries are held in `deferred_voucher` and reach the ledger only when a
-- second person approves. Holding the exact postings rather than recomputing
-- them on approval means the entries the approver agreed to are the entries
-- that land.

alter type doc_status add value if not exists 'pending_approval';
alter type doc_status add value if not exists 'rejected';

-- ------------------------------------------------------------------ rules --

create table if not exists approval_rule (
  tenant_id     uuid not null references tenant(id) on delete cascade,
  doc_type      text not null,
  min_amount    numeric(14,2) not null,
  approver_role text not null,
  is_active     boolean not null default true,
  primary key (tenant_id, doc_type),
  constraint approval_doc_type
    check (doc_type in ('sales_invoice', 'purchase_invoice', 'payment')),
  constraint approval_role
    check (approver_role in ('owner', 'accounts', 'sales', 'purchase', 'store')),
  constraint approval_amount check (min_amount >= 0)
);

/**
 * Who did what, kept separately from the document so a rejection and a later
 * re-approval both survive. The document's own status is the current answer;
 * this is how it got there.
 */
create table if not exists approval_event (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenant(id) on delete cascade,
  doc_type   text not null,
  doc_id     uuid not null,
  action     text not null,
  amount     numeric(14,2),
  actor_id   uuid references app_user(id),
  note       text default '',
  created_at timestamptz not null default now(),
  constraint approval_action check (action in ('submitted', 'approved', 'rejected'))
);

create index if not exists approval_event_by_doc on approval_event (tenant_id, doc_type, doc_id);
create index if not exists approval_event_by_actor on approval_event (actor_id);

-- ------------------------------------------------------- deferred postings --

/**
 * The voucher a pending document *would* post, held until someone approves it.
 * Recomputing the entries at approval time would let a master edited in between
 * change what actually lands; freezing them means the approver's decision and
 * the ledger entry are the same thing.
 */
create table if not exists deferred_voucher (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenant(id) on delete cascade,
  doc_type     text not null,
  doc_id       uuid not null,
  voucher_type text not null,
  voucher_date date not null,
  narration    text not null default '',
  posted_as    uuid references voucher(id),
  created_at   timestamptz not null default now()
);

create unique index if not exists deferred_voucher_one_per_doc
  on deferred_voucher (tenant_id, doc_type, doc_id) where posted_as is null;

create table if not exists deferred_voucher_line (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenant(id) on delete cascade,
  deferred_id uuid not null references deferred_voucher(id) on delete cascade,
  ledger_id   uuid not null references ledger_account(id),
  debit       numeric(14,2) not null default 0,
  credit      numeric(14,2) not null default 0,
  constraint deferred_one_side check ((debit = 0) or (credit = 0))
);

create index if not exists deferred_line_by_voucher on deferred_voucher_line (deferred_id);
create index if not exists deferred_line_by_tenant on deferred_voucher_line (tenant_id);
create index if not exists deferred_line_by_ledger on deferred_voucher_line (ledger_id);

/**
 * A held voucher must balance exactly as a posted one does. Checking only at
 * approval would mean discovering at the worst moment that the entry cannot be
 * made at all.
 */
create or replace function deferred_voucher_balances() returns trigger as $$
declare drift numeric(14,2);
begin
  select coalesce(sum(debit - credit), 0) into drift
    from deferred_voucher_line where deferred_id = new.deferred_id;
  if abs(drift) > 0.005 then
    raise exception 'a held voucher must balance; this one is out by %', drift;
  end if;
  return null;
end $$ language plpgsql;

drop trigger if exists deferred_voucher_is_balanced on deferred_voucher_line;
create constraint trigger deferred_voucher_is_balanced
  after insert or update on deferred_voucher_line
  deferrable initially deferred
  for each row execute function deferred_voucher_balances();

-- ------------------------------------------------------------ privileges --

do $$
declare t text;
begin
  foreach t in array array[
    'approval_rule', 'approval_event', 'deferred_voucher', 'deferred_voucher_line'
  ] loop
    execute format('grant select, insert, update, delete on %I to link_erp_app', t);
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format(
      'create policy tenant_isolation on %I using (tenant_id = current_setting(''app.tenant_id'', true)::uuid)'
      || ' with check (tenant_id = current_setting(''app.tenant_id'', true)::uuid)', t);
  end loop;
end $$;
