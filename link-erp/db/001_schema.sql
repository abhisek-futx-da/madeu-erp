-- Link ERP — core schema. Postgres 14+.
-- Spine: one row in `piece` per physical thaan; every status change is an
-- append-only `piece_movement`. Documents move pieces, they never own them.

create extension if not exists "pgcrypto";
create extension if not exists "citext";

-- ---------------------------------------------------------------- tenancy --

create table tenant (
  id            uuid primary key default gen_random_uuid(),
  legal_name    text not null,
  gstin         char(15) not null,
  pan           char(10) not null,
  state_code    char(2)  not null,
  fy_start      date     not null,
  created_at    timestamptz not null default now(),
  unique (gstin)
);

create table app_user (
  id            uuid primary key default gen_random_uuid(),
  email         citext not null unique,
  full_name     text not null,
  password_hash text not null,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now()
);

create type member_role as enum ('owner','accounts','purchase','sales','store','viewer');

create table membership (
  tenant_id     uuid not null references tenant(id) on delete cascade,
  user_id       uuid not null references app_user(id) on delete cascade,
  role          member_role not null,
  primary key (tenant_id, user_id)
);

-- Per-FY document numbering; legacy runs a separate series per doc type per year.
create table document_series (
  tenant_id     uuid not null references tenant(id) on delete cascade,
  doc_type      text not null,
  fy_label      text not null,
  prefix        text not null default '',
  next_number   bigint not null default 1,
  primary key (tenant_id, doc_type, fy_label)
);

-- ---------------------------------------------------------------- masters --

-- `nature` drives posting behaviour, so accounting never string-matches a name.
create type account_nature as enum (
  'sundry_creditor_grey','sundry_creditor_process','sundry_creditor_finish',
  'sundry_creditor_brokerage','sundry_creditor_transport','sundry_creditor_expense',
  'sundry_debtor_finish','duties_and_taxes','bank','cash','capital','income','expense'
);

create table control_account (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  code          text not null,
  name          text not null,
  sub_control   text not null,
  nature        account_nature not null,
  unique (tenant_id, code)
);

create type gst_reg_type  as enum ('regular','composition','unregistered','sez','overseas');

create table ledger_account (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenant(id) on delete cascade,
  code              text not null,
  name              text not null,
  alias             text not null default '',
  control_account_id uuid not null references control_account(id),
  broker_id         uuid references ledger_account(id),
  transport_id      uuid references ledger_account(id),
  gstin             char(15),
  pan               char(10),
  gst_reg_type      gst_reg_type not null default 'regular',
  is_msme           boolean not null default false,
  msme_ref_no       text,
  auto_tds_tcs      boolean not null default false,
  rcm_applicable    boolean not null default false,
  credit_days       smallint not null default 0,
  credit_limit      numeric(14,2) not null default 0,
  opening_balance   numeric(14,2) not null default 0,
  is_active         boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (tenant_id, code),
  constraint gstin_shape check (gstin is null or gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{3}$'),
  constraint pan_shape   check (pan   is null or pan   ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
  -- A regular/composition party without a GSTIN cannot be invoiced compliantly.
  constraint gstin_required_when_registered
    check (gst_reg_type not in ('regular','composition') or gstin is not null)
);

create table ledger_address (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  ledger_id     uuid not null references ledger_account(id) on delete cascade,
  label         text not null,
  is_ship_to    boolean not null default false,
  is_primary    boolean not null default false,
  line1         text not null,
  city          text not null,
  pincode       char(6),
  state_code    char(2) not null,
  country       text not null default 'India',
  contact_person text,
  contact_no    text,
  email         citext
);
create unique index ledger_one_primary_address
  on ledger_address (ledger_id) where is_primary;

create table hsn_code (
  tenant_id     uuid not null references tenant(id) on delete cascade,
  code          text not null,
  description   text not null,
  gst_rate      numeric(5,2) not null,
  is_service    boolean not null default false,
  primary key (tenant_id, code),
  constraint gst_rate_valid check (gst_rate in (0,0.25,3,5,12,18,28))
);

create type bill_by as enum ('meters','pcs','weight');

create table quality (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  code          text not null,
  name          text not null,
  construction  text not null default '',
  selvedge_line text not null default '',
  width_cms     numeric(6,2),
  bill_by       bill_by not null default 'meters',
  hsn_code      text not null,
  division      text not null default '',
  is_active     boolean not null default true,
  unique (tenant_id, code),
  foreign key (tenant_id, hsn_code) references hsn_code(tenant_id, code)
);

create table design (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  quality_id    uuid not null references quality(id) on delete cascade,
  code          text not null,
  name          text not null,
  unique (tenant_id, quality_id, code)
);

create table grade (
  tenant_id     uuid not null references tenant(id) on delete cascade,
  code          text not null,
  name          text not null,
  sort_order    smallint not null default 0,
  primary key (tenant_id, code)
);

-- ------------------------------------------------------------- the spine --

create type piece_status as enum (
  'grey_in_stock','issued_to_dyeing','received_finish',
  'cut_packed','dispatched','returned_to_weaver','written_off'
);

-- Allowed transitions live in data, so a new status is a new row, not a code edit.
create table piece_status_transition (
  from_status   piece_status not null,
  to_status     piece_status not null,
  primary key (from_status, to_status)
);

insert into piece_status_transition (from_status, to_status) values
  ('grey_in_stock','issued_to_dyeing'), ('grey_in_stock','returned_to_weaver'),
  ('grey_in_stock','written_off'),      ('issued_to_dyeing','received_finish'),
  ('issued_to_dyeing','written_off'),   ('received_finish','cut_packed'),
  ('received_finish','written_off'),    ('cut_packed','dispatched'),
  ('cut_packed','written_off'),         ('dispatched','received_finish');

-- One row per physical thaan. `current_*` are a cached fold of piece_movement.
create table piece (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenant(id) on delete cascade,
  barcode         text not null,
  quality_id      uuid not null references quality(id),
  design_id       uuid references design(id),
  grade_code      text not null,
  lot_no          text not null default '',
  status          piece_status not null default 'grey_in_stock',
  held_by_ledger_id uuid references ledger_account(id),
  grey_qty        numeric(10,2) not null,
  finish_qty      numeric(10,2),
  current_qty     numeric(10,2) not null,
  uom             text not null default 'MTR',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (tenant_id, barcode),
  foreign key (tenant_id, grade_code) references grade(tenant_id, code),
  constraint qty_non_negative check (grey_qty >= 0 and current_qty >= 0
                                     and (finish_qty is null or finish_qty >= 0))
);

create index piece_by_status   on piece (tenant_id, status);
create index piece_by_holder   on piece (tenant_id, held_by_ledger_id) where held_by_ledger_id is not null;
create index piece_by_lot      on piece (tenant_id, lot_no);

create type movement_event as enum (
  'inward','issue','receipt','pack','dispatch','return','adjust','write_off'
);

-- Append-only. The audit trail an ERP is judged on; never updated, never deleted.
create table piece_movement (
  id              bigserial primary key,
  tenant_id       uuid not null references tenant(id) on delete cascade,
  piece_id        uuid not null references piece(id) on delete cascade,
  event           movement_event not null,
  from_status     piece_status,
  to_status       piece_status not null,
  qty_before      numeric(10,2) not null,
  qty_after       numeric(10,2) not null,
  counterparty_id uuid references ledger_account(id),
  doc_type        text not null,
  doc_id          uuid not null,
  occurred_at     timestamptz not null default now(),
  created_by      uuid references app_user(id),
  note            text
);

create index movement_by_piece on piece_movement (piece_id, id);
create index movement_by_doc   on piece_movement (tenant_id, doc_type, doc_id);

create or replace function piece_movement_guard() returns trigger as $$
begin
  if new.from_status is not null
     and not exists (select 1 from piece_status_transition
                     where from_status = new.from_status and to_status = new.to_status) then
    raise exception 'illegal piece transition % -> %', new.from_status, new.to_status;
  end if;
  update piece
     set status = new.to_status,
         current_qty = new.qty_after,
         held_by_ledger_id = new.counterparty_id,
         updated_at = now()
   where id = new.piece_id;
  return new;
end $$ language plpgsql;

create trigger piece_movement_applies_to_piece
  after insert on piece_movement
  for each row execute function piece_movement_guard();

create rule piece_movement_no_update as on update to piece_movement do instead nothing;
create rule piece_movement_no_delete as on delete to piece_movement do instead nothing;

-- -------------------------------------------------------------- documents --

create type doc_status as enum ('draft','approved','partly_done','closed','cancelled');

create table grey_purchase_order (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  order_no      text not null,
  order_date    date not null,
  party_id      uuid not null references ledger_account(id),
  ship_to_id    uuid references ledger_account(id),
  broker_id     uuid references ledger_account(id),
  transport_id  uuid references ledger_account(id),
  delivery_days smallint not null default 0,
  delivery_date date,
  delivery_terms text default '',
  payment_terms text default '',
  vary_percent  numeric(5,2) not null default 0,
  status        doc_status not null default 'draft',
  remarks       text default '',
  created_at    timestamptz not null default now(),
  created_by    uuid references app_user(id),
  unique (tenant_id, order_no)
);

create table grey_purchase_order_line (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  order_id      uuid not null references grey_purchase_order(id) on delete cascade,
  sno           smallint not null,
  quality_id    uuid not null references quality(id),
  design_id     uuid references design(id),
  grade_code    text not null,
  pcs           integer not null,
  cut_length    numeric(10,2) not null,
  qty           numeric(12,2) not null,
  rate          numeric(10,2) not null,
  amount        numeric(14,2) generated always as (qty * rate) stored,
  received_qty  numeric(12,2) not null default 0,
  unique (order_id, sno),
  constraint po_line_positive check (pcs > 0 and qty > 0 and rate >= 0),
  constraint po_line_not_over_received check (received_qty <= qty * 1.10)
);

create table grey_inward (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  entry_no      text not null,
  entry_date    date not null,
  party_id      uuid not null references ledger_account(id),
  challan_no    text not null,
  challan_date  date not null,
  lot_no        text not null default '',
  lr_no         text, lr_date date,
  transport_id  uuid references ledger_account(id),
  broker_id     uuid references ledger_account(id),
  direct_issue  boolean not null default false,
  status        doc_status not null default 'draft',
  remarks       text default '',
  created_at    timestamptz not null default now(),
  created_by    uuid references app_user(id),
  unique (tenant_id, entry_no),
  unique (tenant_id, party_id, challan_no, challan_date)
);

create table grey_inward_line (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  inward_id     uuid not null references grey_inward(id) on delete cascade,
  po_line_id    uuid references grey_purchase_order_line(id),
  piece_id      uuid not null references piece(id),
  sno           smallint not null,
  received_qty  numeric(10,2) not null,
  checked_qty   numeric(10,2) not null,
  rate          numeric(10,2) not null,
  amount        numeric(14,2) generated always as (checked_qty * rate) stored,
  unique (inward_id, sno),
  unique (piece_id)
);

create table dyeing_issue (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenant(id) on delete cascade,
  entry_no          text not null,
  entry_date        date not null,
  process_house_id  uuid not null references ledger_account(id),
  weaver_id         uuid references ledger_account(id),
  challan_no        text not null,
  challan_date      date not null,
  lot_no            text not null default '',
  no_of_bales       smallint not null default 0,
  vehicle_no        text, lr_no text, lr_date date,
  transport_id      uuid references ledger_account(id),
  status            doc_status not null default 'draft',
  remarks           text default '',
  created_at        timestamptz not null default now(),
  created_by        uuid references app_user(id),
  unique (tenant_id, entry_no)
);

create table dyeing_issue_line (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  issue_id      uuid not null references dyeing_issue(id) on delete cascade,
  piece_id      uuid not null references piece(id),
  sno           smallint not null,
  issued_qty    numeric(10,2) not null,
  job_rate      numeric(10,2) not null default 0,
  unique (issue_id, sno),
  unique (issue_id, piece_id)
);

-- The return leg the current prototype has no screen for. Shrinkage is
-- reconciled here: grey out vs finish back, per piece.
create table dyeing_receipt (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenant(id) on delete cascade,
  entry_no          text not null,
  entry_date        date not null,
  process_house_id  uuid not null references ledger_account(id),
  challan_no        text not null,
  challan_date      date not null,
  status            doc_status not null default 'draft',
  remarks           text default '',
  created_at        timestamptz not null default now(),
  created_by        uuid references app_user(id),
  unique (tenant_id, entry_no)
);

create table dyeing_receipt_line (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenant(id) on delete cascade,
  receipt_id      uuid not null references dyeing_receipt(id) on delete cascade,
  issue_line_id   uuid not null references dyeing_issue_line(id),
  piece_id        uuid not null references piece(id),
  sno             smallint not null,
  issued_qty      numeric(10,2) not null,
  received_qty    numeric(10,2) not null,
  shrinkage_qty   numeric(10,2) generated always as (issued_qty - received_qty) stored,
  shrinkage_pct   numeric(6,3) generated always as
                    (case when issued_qty > 0
                          then (issued_qty - received_qty) * 100 / issued_qty end) stored,
  job_rate        numeric(10,2) not null default 0,
  job_amount      numeric(14,2) generated always as (received_qty * job_rate) stored,
  finish_grade    text not null,
  unique (receipt_id, sno),
  unique (issue_line_id),
  constraint receipt_qty_sane check (received_qty >= 0 and received_qty <= issued_qty * 1.05)
);

create table finish_sales_order (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  order_no      text not null,
  order_date    date not null,
  party_id      uuid not null references ledger_account(id),
  ship_to_id    uuid references ledger_account(id),
  broker_id     uuid references ledger_account(id),
  transport_id  uuid references ledger_account(id),
  destination   text default '',
  delivery_days smallint not null default 0,
  delivery_date date,
  payment_terms text default '',
  vary_percent  numeric(5,2) not null default 0,
  status        doc_status not null default 'draft',
  remarks       text default '',
  created_at    timestamptz not null default now(),
  created_by    uuid references app_user(id),
  unique (tenant_id, order_no)
);

create table finish_sales_order_line (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  order_id      uuid not null references finish_sales_order(id) on delete cascade,
  sno           smallint not null,
  quality_id    uuid not null references quality(id),
  design_id     uuid references design(id),
  grade_code    text not null,
  pcs           integer not null,
  cut_length    numeric(10,2) not null,
  qty           numeric(12,2) not null,
  rate          numeric(10,2) not null,
  amount        numeric(14,2) generated always as (qty * rate) stored,
  dispatched_qty numeric(12,2) not null default 0,
  unique (order_id, sno),
  constraint so_line_positive check (pcs > 0 and qty > 0 and rate >= 0)
);

create table dispatch (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  challan_no    text not null,
  challan_date  date not null,
  party_id      uuid not null references ledger_account(id),
  ship_to_id    uuid references ledger_account(id),
  transport_id  uuid references ledger_account(id),
  lr_no         text, lr_date date, vehicle_no text,
  status        doc_status not null default 'draft',
  created_at    timestamptz not null default now(),
  created_by    uuid references app_user(id),
  unique (tenant_id, challan_no)
);

create table dispatch_line (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  dispatch_id   uuid not null references dispatch(id) on delete cascade,
  so_line_id    uuid references finish_sales_order_line(id),
  piece_id      uuid not null references piece(id),
  sno           smallint not null,
  qty           numeric(10,2) not null,
  rate          numeric(10,2) not null,
  unique (dispatch_id, sno),
  unique (dispatch_id, piece_id)
);

-- ------------------------------------------------------------- accounting --

create type voucher_type as enum (
  'purchase','sales','payment','receipt','journal','debit_note','credit_note','jobwork'
);

create table voucher (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  voucher_no    text not null,
  voucher_type  voucher_type not null,
  voucher_date  date not null,
  narration     text default '',
  source_doc    text,
  source_id     uuid,
  is_posted     boolean not null default false,
  created_at    timestamptz not null default now(),
  created_by    uuid references app_user(id),
  unique (tenant_id, voucher_type, voucher_no)
);

create table voucher_line (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  voucher_id    uuid not null references voucher(id) on delete cascade,
  ledger_id     uuid not null references ledger_account(id),
  debit         numeric(14,2) not null default 0,
  credit        numeric(14,2) not null default 0,
  cost_centre   text,
  constraint one_side_only check ((debit = 0) <> (credit = 0)),
  constraint no_negatives  check (debit >= 0 and credit >= 0)
);

create index voucher_line_by_ledger on voucher_line (tenant_id, ledger_id);

-- Deferred so a voucher can be inserted line by line inside one transaction.
create or replace function voucher_must_balance() returns trigger as $$
declare d numeric(14,2); c numeric(14,2);
begin
  select coalesce(sum(debit),0), coalesce(sum(credit),0) into d, c
    from voucher_line where voucher_id = coalesce(new.voucher_id, old.voucher_id);
  if d <> c then
    raise exception 'voucher % out of balance: debit % vs credit %',
      coalesce(new.voucher_id, old.voucher_id), d, c;
  end if;
  return null;
end $$ language plpgsql;

create constraint trigger voucher_balanced
  after insert or update or delete on voucher_line
  deferrable initially deferred
  for each row execute function voucher_must_balance();

create table gst_document (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenant(id) on delete cascade,
  voucher_id        uuid not null references voucher(id) on delete cascade,
  irn               char(64),
  ack_no            text,
  ack_date          timestamptz,
  eway_bill_no      char(12),
  eway_valid_until  timestamptz,
  signed_qr         text,
  filing_status     text not null default 'pending',
  last_error        text,
  unique (tenant_id, irn)
);

-- ------------------------------------------------------- row level security --

-- The API connects as link_erp_app, never as the owner. Policies are ENABLE,
-- not FORCE: the owner must stay able to run migrations and seeds.
-- Password is a deployment concern: ALTER ROLE link_erp_app PASSWORD '...'.
-- Roles are cluster-wide, so creating one is guarded rather than assumed.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'link_erp_app') then
    create role link_erp_app;
  end if;
end $$;
alter role link_erp_app login;

do $$
declare t text;
begin
  foreach t in array array[
    'tenant','app_user','membership','document_series','control_account',
    'ledger_account','ledger_address','hsn_code','quality','design','grade',
    'piece','piece_movement','grey_purchase_order','grey_purchase_order_line',
    'grey_inward','grey_inward_line','dyeing_issue','dyeing_issue_line',
    'dyeing_receipt','dyeing_receipt_line','finish_sales_order',
    'finish_sales_order_line','dispatch','dispatch_line','voucher','voucher_line',
    'gst_document'
  ] loop
    execute format('grant select, insert, update, delete on %I to link_erp_app', t);
  end loop;
end $$;

-- The movement trigger reads this as the calling role, so it needs the grant.
grant select on piece_status_transition to link_erp_app;

do $$
declare t text;
begin

  -- Every tenant-scoped table isolates on the session's app.tenant_id.
  foreach t in array array[
    'ledger_account','ledger_address','control_account','hsn_code','quality','design','grade',
    'piece','piece_movement','grey_purchase_order','grey_purchase_order_line',
    'grey_inward','grey_inward_line','dyeing_issue','dyeing_issue_line',
    'dyeing_receipt','dyeing_receipt_line','finish_sales_order',
    'finish_sales_order_line','dispatch','dispatch_line','voucher','voucher_line',
    'gst_document','document_series'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy tenant_isolation on %I using (tenant_id = current_setting(''app.tenant_id'', true)::uuid)'
      || ' with check (tenant_id = current_setting(''app.tenant_id'', true)::uuid)', t);
  end loop;
end $$;

-- membership is tenant-scoped too; tenant isolates on its own id.
alter table membership enable row level security;
create policy tenant_isolation on membership
  using (tenant_id = current_setting('app.tenant_id', true)::uuid)
  with check (tenant_id = current_setting('app.tenant_id', true)::uuid);

alter table tenant enable row level security;
create policy tenant_isolation on tenant
  using (id = current_setting('app.tenant_id', true)::uuid);

grant usage, select on all sequences in schema public to link_erp_app;

-- Login has to list a user's tenants before any tenant is chosen, so it cannot
-- run under the tenant policy. Definer rights, narrowed to one user's own rows.
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
   where m.user_id = p_user;
$$;

revoke all on function user_memberships(uuid) from public;
grant execute on function user_memberships(uuid) to link_erp_app;

-- ------------------------------------------------------------------ views --

-- Set-based replacements for the prototype's mock report arrays. Each view
-- filters on the session tenant itself: security_invoker needs PG15+, and a
-- view that relied on it would silently leak across tenants on PG14.
create view v_barcode_history as
select m.tenant_id, p.barcode, p.lot_no, q.name as quality, d.name as design,
       m.event, m.from_status, m.to_status, m.qty_before, m.qty_after,
       l.name as counterparty, m.doc_type, m.occurred_at
  from piece_movement m
  join piece p on p.id = m.piece_id
  join quality q on q.id = p.quality_id
  left join design d on d.id = p.design_id
  left join ledger_account l on l.id = m.counterparty_id
 where m.tenant_id = current_setting('app.tenant_id', true)::uuid;

create view v_process_stock as
select p.tenant_id, l.name as process_house, q.name as quality,
       count(*) as pcs, sum(p.current_qty) as qty
  from piece p
  join ledger_account l on l.id = p.held_by_ledger_id
  join quality q on q.id = p.quality_id
 where p.status = 'issued_to_dyeing'
   and p.tenant_id = current_setting('app.tenant_id', true)::uuid
 group by p.tenant_id, l.name, q.name;

create view v_po_pending as
select o.tenant_id, o.id as order_id, o.order_no, o.order_date, l.name as party,
       q.name as quality, d.name as design,
       ol.qty, ol.received_qty, ol.qty - ol.received_qty as balance_qty,
       greatest(0, current_date - o.delivery_date) as delay_days
  from grey_purchase_order_line ol
  join grey_purchase_order o on o.id = ol.order_id
  join ledger_account l on l.id = o.party_id
  join quality q on q.id = ol.quality_id
  left join design d on d.id = ol.design_id
 where o.status not in ('closed','cancelled')
   and ol.received_qty < ol.qty
   and o.tenant_id = current_setting('app.tenant_id', true)::uuid;

create view v_party_balance as
select vl.tenant_id, vl.ledger_id, la.name, la.code,
       sum(vl.debit) - sum(vl.credit) as balance
  from voucher_line vl
  join voucher v on v.id = vl.voucher_id and v.is_posted
  join ledger_account la on la.id = vl.ledger_id
 where vl.tenant_id = current_setting('app.tenant_id', true)::uuid
 group by vl.tenant_id, vl.ledger_id, la.name, la.code;

-- Grey still lying at the mill, and finish ready to sell.
create view v_stock_summary as
select p.tenant_id, p.status, q.name as quality, g.name as grade,
       count(*) as pcs, sum(p.current_qty) as qty
  from piece p
  join quality q on q.id = p.quality_id
  join grade g on g.tenant_id = p.tenant_id and g.code = p.grade_code
 where p.status in ('grey_in_stock','received_finish','cut_packed')
   and p.tenant_id = current_setting('app.tenant_id', true)::uuid
 group by p.tenant_id, p.status, q.name, g.name;

create view v_shrinkage_by_process_house as
select r.tenant_id, l.name as process_house, q.name as quality,
       count(*) as pieces,
       sum(rl.issued_qty) as issued_qty,
       sum(rl.received_qty) as received_qty,
       round(sum(rl.shrinkage_qty) * 100 / nullif(sum(rl.issued_qty), 0), 3) as shrinkage_pct
  from dyeing_receipt_line rl
  join dyeing_receipt r on r.id = rl.receipt_id
  join ledger_account l on l.id = r.process_house_id
  join piece p on p.id = rl.piece_id
  join quality q on q.id = p.quality_id
 where r.tenant_id = current_setting('app.tenant_id', true)::uuid
 group by r.tenant_id, l.name, q.name;

grant select on v_barcode_history, v_process_stock, v_po_pending,
                v_party_balance, v_stock_summary, v_shrinkage_by_process_house
  to link_erp_app;
