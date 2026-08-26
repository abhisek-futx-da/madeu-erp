-- The process-house portal.
--
-- A dyeing house holds the mill's goods for two to three weeks and the mill
-- learns what happened to them by telephone. Every shrinkage argument starts
-- there: nobody wrote down what arrived, what was damaged, or when it was
-- promised back, so both sides reconstruct it afterwards from memory.
--
-- This gives the process house a login of its own that can see only its own
-- custody and can *say* things — we received these, four are damaged, expect
-- them Thursday, they left on our challan 812. It cannot move a piece or post
-- a rupee. Declarations are append-only statements the mill's own staff then
-- accept or reject, so an outside party can never write to the spine, and
-- every word they said survives the argument.

create type declaration_kind as enum (
  'custody_ack',     -- we have the goods you sent
  'shortage',        -- fewer arrived than the challan says
  'rejection',       -- these pieces are damaged or off-shade
  'expected_return', -- when we expect to send them back
  'return_dispatch'  -- they have left, on our challan
);

create type declaration_state as enum ('submitted', 'accepted', 'rejected');

-- ------------------------------------------------------------- identity --

/**
 * An outside login, bound to one ledger account in one tenant. Deliberately
 * not a `membership` row: an internal role carries write access to masters and
 * documents, and a process house must never hold either. One user serves one
 * party, so a shared account cannot drift across two process houses.
 */
create table party_portal_user (
  tenant_id   uuid not null references tenant(id) on delete cascade,
  user_id     uuid not null references app_user(id) on delete cascade,
  party_id    uuid not null references ledger_account(id),
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  created_by  uuid references app_user(id),
  primary key (tenant_id, user_id)
);
create index portal_user_by_party on party_portal_user (tenant_id, party_id);
create index portal_user_by_creator on party_portal_user (created_by);

/**
 * Login has to find the portal account before a tenant is chosen, so it cannot
 * run under the tenant policy. Definer rights, narrowed to one user's own row.
 */
create or replace function portal_membership(p_user uuid)
returns table (tenant_id uuid, party_id uuid, legal_name text, party_name text)
language sql stable security definer set search_path = public as $$
  select p.tenant_id, p.party_id, t.legal_name, l.name
    from party_portal_user p
    join tenant t on t.id = p.tenant_id
    join ledger_account l on l.id = p.party_id
   where p.user_id = p_user and p.is_active;
$$;
revoke all on function portal_membership(uuid) from public;
grant execute on function portal_membership(uuid) to link_erp_app;

/**
 * Is this user still bound to this party in this tenant? Asked on every portal
 * request, before any tenant is established on the connection — so it cannot
 * read `party_portal_user` directly: an unset `app.tenant_id` reverts to the
 * empty string on a pooled connection, and the RLS predicate then casts '' to
 * uuid and errors. Definer rights, narrowed to a yes or no about one row.
 */
create or replace function portal_binding(p_user uuid, p_tenant uuid, p_party uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from party_portal_user
     where user_id = p_user and tenant_id = p_tenant
       and party_id = p_party and is_active
  );
$$;
revoke all on function portal_binding(uuid, uuid, uuid) from public;
grant execute on function portal_binding(uuid, uuid, uuid) to link_erp_app;

-- ---------------------------------------------------------- declarations --

/**
 * What the process house said, and when. Append-only: a shortage that can be
 * edited after the mill disputes it is worth nothing as evidence.
 */
create table party_declaration (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenant(id) on delete cascade,
  party_id     uuid not null references ledger_account(id),
  kind         declaration_kind not null,
  issue_id     uuid references dyeing_issue(id),
  /** Their own challan or vehicle for a return; free text, never trusted. */
  their_ref    text not null default '',
  vehicle_no   text,
  expected_on  date,
  note         text not null default '',
  declared_at  timestamptz not null default now(),
  declared_by  uuid references app_user(id),
  constraint declaration_needs_issue
    check (kind = 'custody_ack' or kind = 'return_dispatch' or issue_id is not null)
);
create index declaration_by_party on party_declaration (tenant_id, party_id, declared_at desc);
create index declaration_by_issue on party_declaration (issue_id);
create index declaration_by_user on party_declaration (declared_by);

/** The pieces a declaration is about, when it is about pieces at all. */
create table party_declaration_line (
  id             bigserial primary key,
  tenant_id      uuid not null references tenant(id) on delete cascade,
  declaration_id uuid not null references party_declaration(id) on delete cascade,
  piece_id       uuid references piece(id),
  barcode        text not null,
  qty            numeric(10,2),
  reason         text not null default '',
  unique (declaration_id, barcode)
);
create index declaration_line_by_declaration on party_declaration_line (declaration_id);
create index declaration_line_by_tenant on party_declaration_line (tenant_id);
create index declaration_line_by_piece on party_declaration_line (piece_id);

/**
 * How the mill answered. Separate and append-only for the same reason the
 * approval trail is: the current state is the latest row, and how it got there
 * survives someone changing their mind.
 */
create table party_declaration_event (
  id             bigserial primary key,
  tenant_id      uuid not null references tenant(id) on delete cascade,
  declaration_id uuid not null references party_declaration(id) on delete cascade,
  state          declaration_state not null,
  note           text not null default '',
  actor_id       uuid references app_user(id),
  created_at     timestamptz not null default now()
);
create index declaration_event_by_declaration
  on party_declaration_event (declaration_id, id desc);
create index declaration_event_by_tenant on party_declaration_event (tenant_id);
create index declaration_event_by_actor on party_declaration_event (actor_id);

do $$
declare t text;
begin
  foreach t in array array[
    'party_declaration', 'party_declaration_line', 'party_declaration_event'
  ] loop
    execute format('create rule %I_no_update as on update to %I do instead nothing', t, t);
    execute format('create rule %I_no_delete as on delete to %I do instead nothing', t, t);
  end loop;
end $$;

-- ---------------------------------------------------------------- views --

/**
 * Everything below narrows on the *session's* party, never on anything the
 * caller sends. `current_setting(..., true)` yields null when the portal
 * identity is absent, and `= null` matches no rows — so a missing identity
 * shows an empty portal rather than somebody else's goods.
 */

create view v_portal_challan as
select di.tenant_id, di.id as issue_id, di.entry_no, di.challan_no, di.challan_date,
       di.lot_no, di.no_of_bales, di.vehicle_no, di.status::text as status,
       count(dil.id)::int as pieces,
       coalesce(sum(dil.issued_qty), 0) as issued_qty,
       max(dil.job_rate) as job_rate,
       (select max(d.declared_at) from party_declaration d
         where d.issue_id = di.id and d.kind = 'custody_ack') as acknowledged_at,
       (select max(d.expected_on) from party_declaration d
         where d.issue_id = di.id and d.kind = 'expected_return') as expected_on,
       -- Aggregated, not per line: the group is the challan, so a bare EXISTS
       -- over one line would silently split the challan into one row per thaan.
       bool_or(exists (select 1 from dyeing_receipt_line rl
                         join dyeing_receipt r on r.id = rl.receipt_id
                        where r.status <> 'cancelled'
                          and rl.issue_line_id = dil.id)) as any_returned
  from dyeing_issue di
  join dyeing_issue_line dil on dil.issue_id = di.id
 where di.status <> 'cancelled'
   and di.tenant_id = current_setting('app.tenant_id', true)::uuid
   and di.process_house_id = current_setting('app.party_id', true)::uuid
 group by di.tenant_id, di.id;

/** The thaans physically in this process house's hands right now. */
create view v_portal_piece as
select p.tenant_id, p.id as piece_id, p.barcode, q.name as quality, d.name as design,
       p.lot_no, p.grade_code, p.current_qty, p.uom, p.status::text as status,
       di.entry_no, di.challan_no, dil.issued_qty, dil.job_rate
  from piece p
  join quality q on q.id = p.quality_id
  left join design d on d.id = p.design_id
  left join lateral (
    select l.* from dyeing_issue_line l
      join dyeing_issue i on i.id = l.issue_id
     where l.piece_id = p.id and i.status <> 'cancelled'
     order by i.challan_date desc, l.id desc limit 1
  ) dil on true
  left join dyeing_issue di on di.id = dil.issue_id
 where p.status = 'issued_to_dyeing'
   and p.tenant_id = current_setting('app.tenant_id', true)::uuid
   and p.held_by_ledger_id = current_setting('app.party_id', true)::uuid;

/** What this party has said, and what the mill answered. */
create view v_portal_declaration as
select d.tenant_id, d.id as declaration_id, d.kind::text as kind, d.their_ref,
       d.vehicle_no, d.expected_on, d.note, d.declared_at,
       di.entry_no, di.challan_no,
       coalesce(e.state::text, 'submitted') as state,
       e.note as mill_note, e.created_at as answered_at,
       (select count(*)::int from party_declaration_line l
         where l.declaration_id = d.id) as pieces
  from party_declaration d
  left join dyeing_issue di on di.id = d.issue_id
  left join lateral (
    select state, note, created_at from party_declaration_event
     where declaration_id = d.id order by id desc limit 1
  ) e on true
 where d.tenant_id = current_setting('app.tenant_id', true)::uuid
   and d.party_id = current_setting('app.party_id', true)::uuid;

/**
 * The mill's side: everything an outside party has said that nobody has
 * answered. Tenant-scoped only — staff see every process house.
 */
create view v_party_declaration_inbox as
select d.tenant_id, d.id as declaration_id, d.kind::text as kind, d.party_id,
       l.name as party, d.their_ref, d.vehicle_no, d.expected_on, d.note,
       d.declared_at, u.full_name as declared_by,
       di.entry_no, di.challan_no,
       coalesce(e.state::text, 'submitted') as state,
       (current_date - d.declared_at::date) as waiting_days,
       (select count(*)::int from party_declaration_line pl
         where pl.declaration_id = d.id) as pieces
  from party_declaration d
  join ledger_account l on l.id = d.party_id
  left join app_user u on u.id = d.declared_by
  left join dyeing_issue di on di.id = d.issue_id
  left join lateral (
    select state, created_at from party_declaration_event
     where declaration_id = d.id order by id desc limit 1
  ) e on true
 where d.tenant_id = current_setting('app.tenant_id', true)::uuid;

-- ----------------------------------------------------------- privileges --

do $$
declare t text;
begin
  foreach t in array array[
    'party_portal_user', 'party_declaration', 'party_declaration_line',
    'party_declaration_event'
  ] loop
    execute format('grant select, insert, update, delete on %I to link_erp_app', t);
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format(
      'create policy tenant_isolation on %I using (tenant_id = current_setting(''app.tenant_id'', true)::uuid)'
      || ' with check (tenant_id = current_setting(''app.tenant_id'', true)::uuid)', t);
  end loop;
end $$;

grant usage, select on sequence party_declaration_line_id_seq to link_erp_app;
grant usage, select on sequence party_declaration_event_id_seq to link_erp_app;
grant select on v_portal_challan, v_portal_piece, v_portal_declaration,
                v_party_declaration_inbox to link_erp_app;
