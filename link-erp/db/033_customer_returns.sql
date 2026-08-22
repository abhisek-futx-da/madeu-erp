
-- Customer Returns
insert into piece_status_transition (from_status, to_status) values
  ('dispatched', 'received_finish'),
  ('received_finish', 'dispatched') -- cancellation of return
on conflict do nothing;

alter type movement_event add value if not exists 'customer_return';

create table customer_return (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenant(id) on delete cascade,
  entry_no    text not null,
  entry_date  date not null,
  customer_id uuid not null references ledger_account(id),
  against_invoice_id uuid not null references sales_invoice(id),
  reason      text not null,
  status      doc_status not null default 'pending_approval',
  created_by  uuid references app_user(id),
  created_at  timestamptz not null default now(),
  unique (tenant_id, entry_no)
);
create index customer_return_by_date on customer_return(tenant_id, entry_date desc, entry_no desc);

create table customer_return_line (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenant(id) on delete cascade,
  return_id   uuid not null references customer_return(id) on delete cascade,
  piece_id    uuid not null references piece(id),
  sno         smallint not null,
  return_qty  numeric(10,2) not null,
  rate        numeric(10,2) not null,
  unique (return_id, sno),
  unique (return_id, piece_id)
);
create index customer_return_line_piece on customer_return_line(piece_id);

grant select, insert, update, delete on customer_return, customer_return_line to link_erp_app;

do $$
declare t text;
begin
  foreach t in array array['customer_return','customer_return_line'] loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy tenant_isolation on %I using (tenant_id = current_setting(''app.tenant_id'', true)::uuid)'
      || ' with check (tenant_id = current_setting(''app.tenant_id'', true)::uuid)', t);
  end loop;
end $$;
