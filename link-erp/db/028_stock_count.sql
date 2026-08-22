-- Physical stock count and variance approval.
--
-- Everything upstream of this is a promise: the movement log says the rack
-- holds 118 metres of Galaxy on A1. Nothing until now walked to the rack and
-- checked. A discrepancy was therefore invisible — and when someone eventually
-- noticed, the only cure was an UPDATE nobody would ever see again.
--
-- A count is a document. It freezes what the system believes, records what was
-- physically scanned, names every disagreement, makes a person choose an
-- outcome and give a reason, makes a second person approve it, and then posts
-- the result through `piece_movement` and the ledger like any other document.
-- There is deliberately no "adjust stock" endpoint: a discrepancy becomes a
-- named, valued, approved event or it does not happen at all.

-- --------------------------------------------------------------- location --

-- Where a piece physically sits. Cached on the piece exactly as status and
-- quantity are, and changed the same way: by inserting a movement.
alter table piece add column if not exists rack_code text;
alter table piece_movement add column if not exists from_rack text;
alter table piece_movement add column if not exists to_rack   text;

alter table piece drop constraint if exists piece_rack_known;
alter table piece add constraint piece_rack_known
  foreign key (tenant_id, rack_code) references rack_master (tenant_id, code);

create index if not exists piece_by_rack
  on piece (tenant_id, rack_code) where rack_code is not null;

-- A movement that names no rack leaves the piece where it was: a dyeing issue
-- is not a statement about shelving.
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
         rack_code = coalesce(new.to_rack, rack_code),
         updated_at = now()
   where id = new.piece_id;
  return new;
end $$ language plpgsql;

-- A correction leaves a piece where it is; without these the guard rejects the
-- very movement that records "this thaan is two metres shorter than we thought".
insert into piece_status_transition (from_status, to_status) values
  ('grey_in_stock','grey_in_stock'),
  ('received_finish','received_finish'),
  ('cut_packed','cut_packed'),
  -- Reversing a count that wrote a piece off has to put it back where it was.
  ('written_off','received_finish'),
  ('written_off','cut_packed')
on conflict (from_status, to_status) do nothing;

create or replace view v_barcode_history as
select m.tenant_id, p.barcode, p.lot_no, q.name as quality, d.name as design,
       m.event, m.from_status, m.to_status, m.qty_before, m.qty_after,
       l.name as counterparty, m.doc_type, m.occurred_at,
       m.from_rack, m.to_rack, m.note
  from piece_movement m
  join piece p on p.id = m.piece_id
  join quality q on q.id = p.quality_id
  left join design d on d.id = p.design_id
  left join ledger_account l on l.id = m.counterparty_id
 where m.tenant_id = current_setting('app.tenant_id', true)::uuid;

-- -------------------------------------------------------------- the count --

create type count_variance_kind as enum (
  'missing',        -- the system has it; the floor does not
  'extra',          -- the floor has it; this count did not expect it
  'short',          -- present, but shorter than the system believes
  'excess',         -- present, but longer
  'wrong_rack',     -- right piece, wrong shelf
  'duplicate_scan'  -- counted more than once; the sheet is not trustworthy
);

/**
 * What a person decided to do about a disagreement. Three of these change
 * stock; three deliberately do not, because a count must never invent a piece
 * it knows nothing about, nor quietly resurrect goods that were billed out.
 */
create type count_outcome as enum (
  'write_off',      -- retire the piece and expense what it carried
  'adjust_qty',     -- the floor's measurement wins; value moves with it
  'relocate',       -- record where it actually is
  'accept_system',  -- the count was wrong, not the system; reason required
  'needs_inward',   -- an unknown barcode: bring it in properly, not here
  'investigate'     -- it should not be here at all; someone must look
);

create table stock_count (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenant(id) on delete cascade,
  count_no     text not null,
  count_date   date not null,
  -- Scope. A null narrows nothing, so a count of everything is three nulls.
  rack_code    text,
  quality_id   uuid references quality(id),
  lot_no       text,
  status       doc_status not null default 'draft',
  reason       text not null default '',
  /**
   * Signed rupees the approved outcomes would move: negative is a loss. Named
   * `net_value` rather than `amount` for readability, and exposed to the
   * approval engine through the same contract every other document uses.
   */
  net_value    numeric(14,2) not null default 0,
  pieces_expected integer not null default 0,
  frozen_at    timestamptz not null default now(),
  submitted_at timestamptz,
  voucher_id   uuid references voucher(id),
  created_by   uuid references app_user(id),
  created_at   timestamptz not null default now(),
  unique (tenant_id, count_no),
  foreign key (tenant_id, rack_code) references rack_master (tenant_id, code)
);
create index stock_count_by_date on stock_count (tenant_id, count_date desc, count_no desc);
create index stock_count_by_quality on stock_count (quality_id);
create index stock_count_by_creator on stock_count (created_by);
create index stock_count_by_voucher on stock_count (voucher_id);

/**
 * What the system believed at the moment the count was opened. Frozen, because
 * a count compared against a moving system proves nothing: goods dispatched
 * while the counter walks the aisle would show as missing.
 */
create table stock_count_expected (
  id         bigserial primary key,
  tenant_id  uuid not null references tenant(id) on delete cascade,
  count_id   uuid not null references stock_count(id) on delete cascade,
  piece_id   uuid not null references piece(id),
  barcode    text not null,
  status     piece_status not null,
  rack_code  text,
  qty        numeric(10,2) not null,
  cost       numeric(12,2) not null default 0,
  unique (count_id, piece_id)
);
create index expected_by_count on stock_count_expected (count_id, barcode);
create index expected_by_tenant on stock_count_expected (tenant_id);
create index expected_by_piece on stock_count_expected (piece_id);

/** What was actually scanned on the floor. A second scan of one barcode is a
 *  fact worth reporting, so nothing is deduplicated on the way in. */
create table stock_count_scan (
  id          bigserial primary key,
  tenant_id   uuid not null references tenant(id) on delete cascade,
  count_id    uuid not null references stock_count(id) on delete cascade,
  barcode     text not null,
  rack_code   text,
  qty         numeric(10,2),
  note        text,
  scanned_at  timestamptz not null default now(),
  scanned_by  uuid references app_user(id),
  constraint scan_qty_sane check (qty is null or qty >= 0)
);
create index scan_by_count on stock_count_scan (count_id, barcode);
create index scan_by_tenant on stock_count_scan (tenant_id);
create index scan_by_user on stock_count_scan (scanned_by);

/**
 * A mis-scan is correctable while the sheet is still open and permanent once
 * it has been submitted. Deleting a scan after submission would let someone
 * make an approved variance disappear from the evidence behind it.
 */
create or replace function scan_sheet_is_open() returns trigger as $$
declare s doc_status;
begin
  select status into s from stock_count where id = coalesce(old.count_id, new.count_id);
  if s is distinct from 'draft' then
    raise exception 'the count sheet is % and its scans can no longer be changed', s;
  end if;
  return coalesce(new, old);
end $$ language plpgsql;

create trigger stock_count_scan_is_final
  before update or delete on stock_count_scan
  for each row execute function scan_sheet_is_open();

/**
 * The frozen decision: one row per disagreement, with what a person chose and
 * why. Written at submission and never edited, so the approver and the auditor
 * read the same thing.
 */
create table stock_count_variance (
  id           bigserial primary key,
  tenant_id    uuid not null references tenant(id) on delete cascade,
  count_id     uuid not null references stock_count(id) on delete cascade,
  piece_id     uuid references piece(id),
  barcode      text not null,
  kind         count_variance_kind not null,
  outcome      count_outcome not null,
  system_qty   numeric(10,2),
  counted_qty  numeric(10,2),
  system_rack  text,
  counted_rack text,
  /** Signed: negative is stock leaving the books. Zero unless the outcome moves value. */
  value        numeric(14,2) not null default 0,
  reason       text not null,
  unique (count_id, barcode, kind),
  constraint variance_reason_given check (length(btrim(reason)) > 0)
);
create index variance_by_count on stock_count_variance (count_id);
create index variance_by_tenant on stock_count_variance (tenant_id);
create index variance_by_piece on stock_count_variance (piece_id);

create rule stock_count_variance_no_update as
  on update to stock_count_variance do instead nothing;
create rule stock_count_variance_no_delete as
  on delete to stock_count_variance do instead nothing;

-- ------------------------------------------------------------- exceptions --

/**
 * Every disagreement between the frozen snapshot and the floor, computed
 * rather than stored, so an open sheet always reflects the latest scan.
 * `value` is what the piece would carry out of the books if the obvious
 * outcome were chosen; the operator still has to choose it.
 */
create view v_stock_count_exception as
with latest as (
  select distinct on (s.count_id, s.barcode)
         s.count_id, s.barcode, s.rack_code, s.qty, s.tenant_id
    from stock_count_scan s
   order by s.count_id, s.barcode, s.id desc
), tally as (
  select count_id, barcode, count(*)::int as times
    from stock_count_scan group by count_id, barcode
), rate as (
  select e.*, case when e.qty > 0 then e.cost / e.qty else 0 end as per_unit
    from stock_count_expected e
)
select e.tenant_id, e.count_id, e.barcode, e.piece_id,
       'missing'::count_variance_kind as kind,
       e.qty as system_qty, 0::numeric(10,2) as counted_qty,
       e.rack_code as system_rack, null::text as counted_rack,
       round(-e.cost, 2) as value
  from rate e
 where not exists (select 1 from latest l where l.count_id = e.count_id and l.barcode = e.barcode)

union all
select l.tenant_id, l.count_id, l.barcode, p.id,
       'extra'::count_variance_kind, null, coalesce(l.qty, p.current_qty), null, l.rack_code, 0
  from latest l
  left join piece p on p.tenant_id = l.tenant_id and p.barcode = l.barcode
 where not exists (select 1 from stock_count_expected e
                    where e.count_id = l.count_id and e.barcode = l.barcode)

union all
select e.tenant_id, e.count_id, e.barcode, e.piece_id,
       (case when l.qty < e.qty then 'short' else 'excess' end)::count_variance_kind,
       e.qty, l.qty, e.rack_code, l.rack_code,
       round((l.qty - e.qty) * e.per_unit, 2)
  from rate e
  join latest l on l.count_id = e.count_id and l.barcode = e.barcode
 where l.qty is not null and l.qty <> e.qty

union all
select e.tenant_id, e.count_id, e.barcode, e.piece_id,
       'wrong_rack'::count_variance_kind, e.qty, coalesce(l.qty, e.qty), e.rack_code, l.rack_code, 0
  from rate e
  join latest l on l.count_id = e.count_id and l.barcode = e.barcode
 where l.rack_code is not null and l.rack_code is distinct from e.rack_code

union all
select l.tenant_id, s.count_id, s.barcode, e.piece_id,
       'duplicate_scan'::count_variance_kind, e.qty, l.qty, e.rack_code, l.rack_code, 0
  from tally s
  join latest l on l.count_id = s.count_id and l.barcode = s.barcode
  left join stock_count_expected e on e.count_id = s.count_id and e.barcode = s.barcode
 where s.times > 1;

-- What a counter carries to the rack.
create view v_stock_count_sheet as
select e.tenant_id, e.count_id, c.count_no, c.count_date,
       e.barcode, q.name as quality, d.name as design, e.status::text as status,
       e.rack_code, e.qty, e.cost, p.lot_no, p.grade_code,
       exists (select 1 from stock_count_scan s
                where s.count_id = e.count_id and s.barcode = e.barcode) as scanned
  from stock_count_expected e
  join stock_count c on c.id = e.count_id
  join piece p on p.id = e.piece_id
  join quality q on q.id = p.quality_id
  left join design d on d.id = p.design_id
 where e.tenant_id = current_setting('app.tenant_id', true)::uuid;

-- What the owner reads: one line per count, and what it cost.
create view v_stock_count_summary as
select c.tenant_id, c.id as count_id, c.count_no, c.count_date, c.status::text as status,
       c.rack_code, q.name as quality, c.lot_no, c.reason,
       c.pieces_expected,
       (select count(*)::int from (select distinct barcode from stock_count_scan s
                                    where s.count_id = c.id) x) as pieces_counted,
       (select count(*)::int from stock_count_variance v where v.count_id = c.id) as variances,
       (select coalesce(sum(v.value), 0) from stock_count_variance v
         where v.count_id = c.id and v.value < 0) as loss_value,
       (select coalesce(sum(v.value), 0) from stock_count_variance v
         where v.count_id = c.id and v.value > 0) as gain_value,
       c.net_value, u.full_name as counted_by, c.created_at, c.submitted_at
  from stock_count c
  left join quality q on q.id = c.quality_id
  left join app_user u on u.id = c.created_by
 where c.tenant_id = current_setting('app.tenant_id', true)::uuid;

-- The variance report, readable without joining anything by hand.
create view v_stock_count_variance as
select v.tenant_id, v.count_id, c.count_no, c.count_date, c.status::text as doc_status,
       v.barcode, v.kind::text as kind, v.outcome::text as outcome,
       v.system_qty, v.counted_qty, v.system_rack, v.counted_rack,
       v.value, v.reason, q.name as quality, p.lot_no
  from stock_count_variance v
  join stock_count c on c.id = v.count_id
  left join piece p on p.id = v.piece_id
  left join quality q on q.id = p.quality_id
 where v.tenant_id = current_setting('app.tenant_id', true)::uuid;

-- ------------------------------------------------------------- accounting --

alter type posting_role add value if not exists 'stock_loss';
alter type posting_role add value if not exists 'stock_gain';

-- A count is a control, so it is approvable at any value — including zero,
-- where the thing being approved is the assertion that nothing is wrong.
alter table approval_rule drop constraint if exists approval_doc_type;
alter table approval_rule add constraint approval_doc_type
  check (doc_type in ('sales_invoice', 'purchase_invoice', 'payment', 'stock_count'));

-- ------------------------------------------------------------- privileges --

do $$
declare t text;
begin
  foreach t in array array[
    'stock_count','stock_count_expected','stock_count_scan','stock_count_variance'
  ] loop
    execute format('grant select, insert, update, delete on %I to link_erp_app', t);
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format(
      'create policy tenant_isolation on %I using (tenant_id = current_setting(''app.tenant_id'', true)::uuid)'
      || ' with check (tenant_id = current_setting(''app.tenant_id'', true)::uuid)', t);
  end loop;
end $$;

grant usage, select on sequence stock_count_expected_id_seq to link_erp_app;
grant usage, select on sequence stock_count_scan_id_seq to link_erp_app;
grant usage, select on sequence stock_count_variance_id_seq to link_erp_app;
grant select on v_stock_count_exception, v_stock_count_sheet,
                v_stock_count_summary, v_stock_count_variance to link_erp_app;
