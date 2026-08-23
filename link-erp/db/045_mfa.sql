-- Authenticator MFA is global to a person, just like their password. Secrets
-- are encrypted by an application key that is not stored in this database;
-- recovery codes are one-way hashes and each can be consumed only once.

create table user_mfa (
  user_id            uuid primary key references app_user(id) on delete cascade,
  secret_encrypted   text not null,
  recovery_hashes    text[] not null,
  enabled_at         timestamptz,
  last_counter       bigint not null default -1,
  created_at         timestamptz not null default now()
);

create table mfa_audit (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references app_user(id) on delete cascade,
  event       text not null,
  occurred_at timestamptz not null default now(),
  constraint mfa_audit_event check (event in ('setup_started','enabled','recovery_used','disabled','admin_reset'))
);
create index mfa_audit_by_user on mfa_audit (user_id, occurred_at desc);

create or replace function prevent_mfa_audit_rewrite()
returns trigger language plpgsql as $$
begin
  raise exception 'MFA audit is append-only';
end;
$$;
create trigger mfa_audit_no_rewrite before update or delete on mfa_audit
  for each row execute function prevent_mfa_audit_rewrite();

grant select, insert, update, delete on user_mfa to link_erp_app;
grant select, insert on mfa_audit to link_erp_app;
grant usage, select on sequence mfa_audit_id_seq to link_erp_app;

alter table access_audit drop constraint access_audit_event_check;
alter table access_audit add constraint access_audit_event_check check (event in (
  'user_created', 'membership_changed', 'membership_disabled',
  'password_changed', 'password_reset', 'mfa_reset'
));
