-- Contra: money moving between the mill's own cash and bank accounts.
--
-- Cash deposited into the bank, cash drawn for wages, a transfer between two
-- banks. No party is involved and nothing is bought or sold, so it is neither
-- a receipt nor a payment — booking it as one puts a fictional counterparty
-- into a supplier's or customer's ledger.
--
-- It is a distinct voucher type so the day book, the cash book and the bank
-- reconciliation can all tell it apart from trade.

alter type voucher_type add value if not exists 'contra';

create table if not exists contra_entry (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  entry_no      text not null,
  entry_date    date not null,
  from_ledger_id uuid not null references ledger_account(id),
  to_ledger_id   uuid not null references ledger_account(id),
  amount        numeric(14,2) not null,
  instrument_no text,
  narration     text not null default '',
  status        doc_status not null default 'approved',
  voucher_id    uuid references voucher(id),
  created_at    timestamptz not null default now(),
  created_by    uuid references app_user(id),
  unique (tenant_id, entry_no),
  constraint contra_amount_positive check (amount > 0),
  -- Money cannot move from an account to itself.
  constraint contra_two_accounts check (from_ledger_id <> to_ledger_id)
);

create index if not exists contra_by_date on contra_entry (tenant_id, entry_date desc, entry_no desc);
create index if not exists contra_by_from on contra_entry (from_ledger_id);
create index if not exists contra_by_to on contra_entry (to_ledger_id);
create index if not exists contra_by_voucher on contra_entry (voucher_id) where voucher_id is not null;

alter table contra_entry enable row level security;
drop policy if exists tenant_isolation on contra_entry;
create policy tenant_isolation on contra_entry
  using (tenant_id = current_setting('app.tenant_id', true)::uuid)
  with check (tenant_id = current_setting('app.tenant_id', true)::uuid);

grant select, insert, update on contra_entry to link_erp_app;

create or replace view v_contra_entry as
select c.tenant_id, c.id, c.entry_no, c.entry_date,
       f.code as from_code, f.name as from_account,
       t.code as to_code,   t.name as to_account,
       c.amount, c.instrument_no, c.narration, c.status::text as status,
       v.voucher_no
  from contra_entry c
  join ledger_account f on f.id = c.from_ledger_id
  join ledger_account t on t.id = c.to_ledger_id
  left join voucher v on v.id = c.voucher_id
 where c.tenant_id = current_setting('app.tenant_id', true)::uuid;

grant select on v_contra_entry to link_erp_app;

/**
 * Cash and bank movement including contras.
 *
 * v_cash_book is left exactly as it stands: its `kind` column is the
 * payment_kind enum, and a view column's type cannot be widened in place —
 * so the complete book is a view of its own rather than a risky drop of one
 * that other things read. A deposit used to vanish from the cash book on its
 * way to the bank; here both legs show, out of one account and into the other.
 */
create or replace view v_cash_and_bank_book as
select p.tenant_id, p.payment_date as entry_date, p.voucher_no,
       p.kind::text as kind, p.mode::text as mode,
       l.name as party, b.name as account, p.instrument_no,
       case when p.kind = 'receipt' then p.amount else 0::numeric(14,2) end as inflow,
       case when p.kind = 'payment' then p.amount else 0::numeric(14,2) end as outflow,
       p.narration
  from payment p
  join ledger_account l on l.id = p.party_id
  left join ledger_account b on b.id = p.bank_ledger_id
 where is_live(p.status)
   and p.tenant_id = current_setting('app.tenant_id', true)::uuid
union all
-- Two legs per contra: the account drawn on, then the account fed.
select c.tenant_id, c.entry_date, v.voucher_no, 'contra', 'transfer',
       t.name, f.name, c.instrument_no,
       0::numeric(14,2), c.amount, c.narration
  from contra_entry c
  join ledger_account f on f.id = c.from_ledger_id
  join ledger_account t on t.id = c.to_ledger_id
  left join voucher v on v.id = c.voucher_id
 where is_live(c.status)
   and c.tenant_id = current_setting('app.tenant_id', true)::uuid
union all
select c.tenant_id, c.entry_date, v.voucher_no, 'contra', 'transfer',
       f.name, t.name, c.instrument_no,
       c.amount, 0::numeric(14,2), c.narration
  from contra_entry c
  join ledger_account f on f.id = c.from_ledger_id
  join ledger_account t on t.id = c.to_ledger_id
  left join voucher v on v.id = c.voucher_id
 where is_live(c.status)
   and c.tenant_id = current_setting('app.tenant_id', true)::uuid;

grant select on v_cash_and_bank_book to link_erp_app;
