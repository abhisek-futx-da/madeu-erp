-- Staff access is a business control, not a convenience setting.  A person
-- may work for more than one tenant, so disabling their access to one company
-- must never disable them everywhere.  Password resets invalidate every one
-- of that person's existing sessions.

alter table app_user
  add column if not exists session_version integer not null default 0,
  add constraint app_user_session_version_nonnegative check (session_version >= 0);

alter table membership
  add column if not exists is_active boolean not null default true;

create index if not exists membership_active_by_tenant
  on membership (tenant_id, is_active, user_id);

-- Login happens before the application can set app.tenant_id.  Keep this
-- narrow security-definer function, but do not return disabled memberships.
create or replace function user_memberships(p_user uuid)
returns table (tenant_id uuid, role member_role, legal_name text)
language sql
stable
security definer
set search_path = public
as $$
  select m.tenant_id, m.role, t.legal_name
    from membership m
    join tenant t on t.id = m.tenant_id
   where m.user_id = p_user
     and m.is_active;
$$;

revoke all on function user_memberships(uuid) from public;
grant execute on function user_memberships(uuid) to link_erp_app;

-- The last active owner cannot be quietly removed, demoted, or disabled.  A
-- constraint trigger is deferred so a transaction may promote a replacement
-- owner before removing the previous one.
create or replace function membership_requires_active_owner()
returns trigger
language plpgsql
as $$
declare affected_tenant uuid := coalesce(new.tenant_id, old.tenant_id);
begin
  if not exists (
    select 1 from membership
     where tenant_id = affected_tenant
       and role = 'owner'
       and is_active
  ) then
    raise exception 'a company must retain at least one active owner';
  end if;
  return null;
end;
$$;

drop trigger if exists membership_requires_active_owner on membership;
create constraint trigger membership_requires_active_owner
after update or delete on membership
deferrable initially deferred
for each row execute function membership_requires_active_owner();

-- Access changes are financial-control events.  They are append-only for the
-- application role so an owner can review who gave, removed, or reset access.
create table if not exists access_audit (
  id             bigint generated always as identity primary key,
  tenant_id      uuid not null references tenant(id) on delete cascade,
  actor_id       uuid references app_user(id),
  target_user_id uuid references app_user(id),
  event          text not null check (event in (
    'user_created', 'membership_changed', 'membership_disabled',
    'password_changed', 'password_reset'
  )),
  details        jsonb not null default '{}'::jsonb,
  occurred_at    timestamptz not null default now()
);

create index if not exists access_audit_by_tenant_time
  on access_audit (tenant_id, occurred_at desc);

alter table access_audit enable row level security;
create policy tenant_isolation on access_audit
  using (tenant_id = current_setting('app.tenant_id', true)::uuid)
  with check (tenant_id = current_setting('app.tenant_id', true)::uuid);

grant select, insert on access_audit to link_erp_app;
grant usage, select on sequence access_audit_id_seq to link_erp_app;

create or replace function prevent_access_audit_rewrite()
returns trigger language plpgsql as $$
begin
  raise exception 'access audit entries are append-only';
end;
$$;

create trigger access_audit_no_rewrite
  before update or delete on access_audit
  for each row execute function prevent_access_audit_rewrite();
