-- A timestamp on a payment is not a bank reconciliation. A reconciliation
-- needs the statement boundary, every bank line, an explicit match, a book
-- balance proof, and a second person to close it.

create table bank_reconciliation (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenant(id) on delete cascade,
  bank_account_id   uuid not null references bank_account(id),
  statement_from    date not null,
  statement_to      date not null,
  opening_balance   numeric(14,2) not null,
  closing_balance   numeric(14,2) not null,
  status            text not null default 'draft',
  created_by        uuid not null references app_user(id),
  created_at        timestamptz not null default now(),
  completed_by      uuid references app_user(id),
  completed_at      timestamptz,
  unique (tenant_id, bank_account_id, statement_from, statement_to),
  constraint bank_reconciliation_dates check (statement_to >= statement_from),
  constraint bank_reconciliation_status check (status in ('draft','completed','cancelled')),
  constraint bank_reconciliation_completion check (
    (status = 'completed' and completed_by is not null and completed_at is not null)
    or (status <> 'completed' and completed_by is null and completed_at is null)
  )
);

create table bank_statement_line (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references tenant(id) on delete cascade,
  reconciliation_id     uuid not null references bank_reconciliation(id) on delete cascade,
  sequence_no           integer not null,
  txn_date              date not null,
  value_date            date,
  reference             text,
  description           text not null default '',
  amount                numeric(14,2) not null,
  matched_payment_id    uuid references payment(id),
  matched_by            uuid references app_user(id),
  matched_at            timestamptz,
  unique (reconciliation_id, sequence_no),
  constraint bank_line_nonzero check (amount <> 0),
  constraint bank_line_match_complete check (
    (matched_payment_id is null and matched_by is null and matched_at is null)
    or (matched_payment_id is not null and matched_by is not null and matched_at is not null)
  )
);

create index bank_reconciliation_by_account
  on bank_reconciliation (tenant_id, bank_account_id, statement_to desc);
create index bank_statement_by_reconciliation
  on bank_statement_line (tenant_id, reconciliation_id, sequence_no);
create unique index bank_statement_payment_once
  on bank_statement_line (tenant_id, matched_payment_id)
  where matched_payment_id is not null;

alter table bank_reconciliation enable row level security;
alter table bank_statement_line enable row level security;
create policy tenant_isolation on bank_reconciliation
  using (tenant_id = current_setting('app.tenant_id', true)::uuid)
  with check (tenant_id = current_setting('app.tenant_id', true)::uuid);
create policy tenant_isolation on bank_statement_line
  using (tenant_id = current_setting('app.tenant_id', true)::uuid)
  with check (tenant_id = current_setting('app.tenant_id', true)::uuid);

grant select, insert, update, delete on bank_reconciliation, bank_statement_line to link_erp_app;

create or replace function bank_reconciliation_integrity()
returns trigger language plpgsql as $$
declare parent bank_reconciliation%rowtype; payment_tenant uuid;
begin
  if tg_table_name = 'bank_reconciliation' then
    if tg_op <> 'INSERT' and old.status = 'completed' then
      raise exception 'a completed bank reconciliation is immutable';
    end if;
    if tg_op = 'DELETE' then return old; end if;
    if not exists (
      select 1 from bank_account b
       where b.id = new.bank_account_id and b.tenant_id = new.tenant_id
    ) then
      raise exception 'bank account does not belong to this tenant';
    end if;
    return new;
  end if;

  select * into parent from bank_reconciliation where id = coalesce(new.reconciliation_id, old.reconciliation_id);
  if parent.status <> 'draft' then
    raise exception 'bank statement lines are frozen once the reconciliation is %', parent.status;
  end if;
  if coalesce(new.tenant_id, old.tenant_id) <> parent.tenant_id then
    raise exception 'bank statement line does not belong to this tenant';
  end if;
  if tg_op <> 'DELETE' and new.matched_payment_id is not null then
    select tenant_id into payment_tenant from payment where id = new.matched_payment_id;
    if payment_tenant is distinct from new.tenant_id then
      raise exception 'matched payment does not belong to this tenant';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create trigger bank_reconciliation_integrity_guard
  before insert or update or delete on bank_reconciliation
  for each row execute function bank_reconciliation_integrity();
create trigger bank_statement_integrity_guard
  before insert or update or delete on bank_statement_line
  for each row execute function bank_reconciliation_integrity();
