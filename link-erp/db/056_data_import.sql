-- Controlled migration workbench.  Spreadsheet data is staged, explained and
-- approved before it can touch a live master.  An import is tenant scoped,
-- immutable after application, and its rows are append-only evidence.

create type data_import_status as enum ('previewed', 'applied', 'rejected');
create type data_import_action as enum ('insert', 'update', 'error');

create table data_import (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenant(id) on delete cascade,
  resource    text not null check (resource in (
    'grades', 'hsn-codes', 'units', 'widths', 'racks', 'qualities', 'ledgers'
  )),
  filename    text not null,
  status      data_import_status not null default 'previewed',
  total_rows  integer not null,
  valid_rows  integer not null,
  error_rows  integer not null,
  created_by  uuid not null references app_user(id),
  created_at  timestamptz not null default now(),
  applied_at  timestamptz,
  unique (id, tenant_id),
  constraint data_import_counts_sane check (
    total_rows >= 0 and valid_rows >= 0 and error_rows >= 0
    and total_rows = valid_rows + error_rows
  ),
  constraint data_import_applied_sane check (
    (status = 'applied' and applied_at is not null and error_rows = 0)
    or (status <> 'applied' and applied_at is null)
  )
);

create table data_import_row (
  id              bigint generated always as identity primary key,
  tenant_id       uuid not null references tenant(id) on delete cascade,
  import_id       uuid not null,
  row_no          integer not null check (row_no > 0),
  raw_data        jsonb not null,
  normalized_data jsonb not null,
  action          data_import_action not null,
  errors          text[] not null default '{}',
  unique (import_id, row_no),
  foreign key (import_id, tenant_id)
    references data_import(id, tenant_id) on delete cascade,
  constraint data_import_row_result_sane check (
    (action = 'error' and cardinality(errors) > 0)
    or (action <> 'error' and cardinality(errors) = 0)
  )
);

create index data_import_by_tenant_time
  on data_import (tenant_id, created_at desc);
create index data_import_row_by_batch
  on data_import_row (tenant_id, import_id, row_no);

alter table data_import enable row level security;
alter table data_import force row level security;
create policy tenant_isolation on data_import
  using (tenant_id = current_setting('app.tenant_id', true)::uuid)
  with check (tenant_id = current_setting('app.tenant_id', true)::uuid);

alter table data_import_row enable row level security;
alter table data_import_row force row level security;
create policy tenant_isolation on data_import_row
  using (tenant_id = current_setting('app.tenant_id', true)::uuid)
  with check (tenant_id = current_setting('app.tenant_id', true)::uuid);

grant select, insert, update on data_import to link_erp_app;
grant select, insert on data_import_row to link_erp_app;
grant usage, select on sequence data_import_row_id_seq to link_erp_app;

-- Preview evidence is never rewritten.  Reject the statement instead of
-- silently doing nothing: a caller must know an audit mutation was refused.
create or replace function prevent_data_import_row_rewrite()
returns trigger language plpgsql as $$
begin
  raise exception 'import preview rows are append-only';
end;
$$;

create trigger data_import_row_no_rewrite
  before update or delete on data_import_row
  for each row execute function prevent_data_import_row_rewrite();

-- Only the lifecycle fields may change, and only once from previewed.  This
-- makes the stored preview a defensible record of exactly what was applied.
create or replace function guard_data_import_lifecycle()
returns trigger language plpgsql as $$
begin
  if old.status <> 'previewed' then
    raise exception 'a completed import is immutable';
  end if;
  if new.status not in ('applied', 'rejected') then
    raise exception 'an import may only be applied or rejected';
  end if;
  if (new.id, new.tenant_id, new.resource, new.filename, new.total_rows,
      new.valid_rows, new.error_rows, new.created_by, new.created_at)
     is distinct from
     (old.id, old.tenant_id, old.resource, old.filename, old.total_rows,
      old.valid_rows, old.error_rows, old.created_by, old.created_at) then
    raise exception 'import evidence cannot be changed';
  end if;
  return new;
end;
$$;

create trigger data_import_lifecycle
  before update on data_import
  for each row execute function guard_data_import_lifecycle();
