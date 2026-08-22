-- Returning defective goods to weavers or process houses.
-- Unlike a cancellation (which erases a mistake), a return is a real operational
-- fact: goods arrived, were found wanting, and went back out.

alter type piece_status add value if not exists 'returned_to_process_house';
insert into piece_status_transition (from_status, to_status) values
  ('received_finish', 'returned_to_process_house'),
  ('returned_to_process_house', 'received_finish'), -- cancellation of return
  ('returned_to_weaver', 'grey_in_stock') -- cancellation of return
on conflict do nothing;

alter type movement_event add value if not exists 'return_grey';
alter type movement_event add value if not exists 'return_finish';

create table grey_return (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenant(id) on delete cascade,
  entry_no    text not null,
  entry_date  date not null,
  weaver_id   uuid not null references ledger_account(id),
  challan_no  text not null default '',
  challan_date date,
  reason      text not null,
  status      doc_status not null default 'approved',
  created_by  uuid references app_user(id),
  created_at  timestamptz not null default now(),
  unique (tenant_id, entry_no)
);
create index grey_return_by_date on grey_return(tenant_id, entry_date desc, entry_no desc);

create table grey_return_line (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenant(id) on delete cascade,
  return_id   uuid not null references grey_return(id) on delete cascade,
  piece_id    uuid not null references piece(id),
  sno         smallint not null,
  return_qty  numeric(10,2) not null,
  grey_rate   numeric(10,2) not null,
  unique (return_id, sno),
  unique (return_id, piece_id)
);
create index grey_return_line_piece on grey_return_line(piece_id);

create table dyeing_return (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenant(id) on delete cascade,
  entry_no          text not null,
  entry_date        date not null,
  process_house_id  uuid not null references ledger_account(id),
  challan_no        text not null default '',
  challan_date      date,
  reason            text not null,
  status            doc_status not null default 'approved',
  created_by        uuid references app_user(id),
  created_at        timestamptz not null default now(),
  unique (tenant_id, entry_no)
);
create index dyeing_return_by_date on dyeing_return(tenant_id, entry_date desc, entry_no desc);

create table dyeing_return_line (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenant(id) on delete cascade,
  return_id   uuid not null references dyeing_return(id) on delete cascade,
  piece_id    uuid not null references piece(id),
  sno         smallint not null,
  return_qty  numeric(10,2) not null,
  jobwork_rate numeric(10,2) not null,
  unique (return_id, sno),
  unique (return_id, piece_id)
);
create index dyeing_return_line_piece on dyeing_return_line(piece_id);

grant select, insert, update, delete on grey_return, grey_return_line, dyeing_return, dyeing_return_line to link_erp_app;

do $$
declare t text;
begin
  foreach t in array array['grey_return','grey_return_line','dyeing_return','dyeing_return_line'] loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy tenant_isolation on %I using (tenant_id = current_setting(''app.tenant_id'', true)::uuid)'
      || ' with check (tenant_id = current_setting(''app.tenant_id'', true)::uuid)', t);
  end loop;
end $$;
