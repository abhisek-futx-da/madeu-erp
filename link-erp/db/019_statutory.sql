-- The statutory documents a textile processor actually raises every day, and
-- which the system had no representation of: the Rule 55 delivery challan that
-- accompanies grey to a dyeing house, the Rule 138 e-way bill that must travel
-- with it, and the ITC-04 return that reports both. Plus the filing lock that
-- stops a filed period from silently changing, and auth state that survives a
-- restart.

-- ------------------------------------------------------------ filing lock --

/**
 * A return, once filed, is a statement to the department. Cancelling an
 * invoice inside a filed period used to make it vanish from GSTR-1 and 3B
 * retrospectively; the lawful correction is a credit note in the current
 * period. This makes that the only available route.
 */
create table if not exists gst_filing (
  tenant_id     uuid not null references tenant(id) on delete cascade,
  return_type   text not null,
  return_period text not null,
  filed_at      timestamptz not null default now(),
  filed_by      uuid references app_user(id),
  arn           text,
  primary key (tenant_id, return_type, return_period),
  constraint filing_type check (return_type in ('GSTR1', 'GSTR3B', 'ITC04')),
  constraint filing_period check (return_period ~ '^(0[1-9]|1[0-2])-[0-9]{4}$'
                                or return_period ~ '^Q[1-4]-[0-9]{4}$')
);

create or replace function invoice_period_is_open() returns trigger as $$
declare period text;
begin
  period := to_char(coalesce(new.invoice_date, old.invoice_date), 'MM-YYYY');
  if exists (select 1 from gst_filing f
              where f.tenant_id = coalesce(new.tenant_id, old.tenant_id)
                and f.return_type = 'GSTR1' and f.return_period = period) then
    raise exception 'GSTR-1 for % is already filed; raise a credit note instead', period;
  end if;
  return new;
end $$ language plpgsql;

drop trigger if exists sales_invoice_period_open on sales_invoice;
create trigger sales_invoice_period_open
  before insert on sales_invoice
  for each row execute function invoice_period_is_open();

-- Only cancellation is blocked on update; an IRN or status change is not.
drop trigger if exists sales_invoice_no_retro_cancel on sales_invoice;
create trigger sales_invoice_no_retro_cancel
  before update of status on sales_invoice
  for each row when (new.status = 'cancelled' and old.status <> 'cancelled')
  execute function invoice_period_is_open();

-- ---------------------------------------------------------- e-way bill --

do $$ begin
  create type ewb_status as enum ('draft', 'generated', 'cancelled', 'failed');
exception when duplicate_object then null; end $$;

/**
 * Rule 138. Shape follows the NIC EWB API v1.03 GENEWAYBILL request so the
 * stored payload is the thing that gets posted, not a translation of it.
 * `sub_supply_type` 1 = Supply, 4 = Job Work — the two a mill uses.
 */
create table if not exists eway_bill (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenant(id) on delete cascade,
  source_doc       text not null,
  source_id        uuid not null,
  our_ref          text not null,
  ewb_no           text,
  ewb_date         timestamptz,
  valid_until      date,
  supply_type      char(1) not null default 'O',
  sub_supply_type  text not null,
  doc_type         text not null,
  doc_no           text not null,
  doc_date         date not null,
  from_gstin       char(15) not null,
  from_pincode     char(6) not null,
  from_state_code  text not null,
  to_gstin         text not null,
  to_pincode       char(6) not null,
  to_state_code    text not null,
  distance_km      integer not null,
  trans_mode       char(1) not null default '1',
  transporter_gstin text,
  transporter_name text,
  trans_doc_no     text,
  trans_doc_date   date,
  vehicle_no       text,
  vehicle_type     char(1) not null default 'R',
  total_value      numeric(14,2) not null,
  cgst_amount      numeric(14,2) not null default 0,
  sgst_amount      numeric(14,2) not null default 0,
  igst_amount      numeric(14,2) not null default 0,
  payload          jsonb,
  status           ewb_status not null default 'draft',
  last_error       text,
  created_at       timestamptz not null default now(),
  created_by       uuid references app_user(id),
  constraint ewb_source check (source_doc in ('sales_invoice', 'dyeing_issue')),
  constraint ewb_sub_supply check (sub_supply_type in ('1', '3', '4', '5', '8')),
  constraint ewb_doc_type check (doc_type in ('INV', 'CHL', 'BIL', 'BOE', 'OTH')),
  constraint ewb_mode check (trans_mode in ('1', '2', '3', '4')),
  -- Rule 138(10): one day per 200 km or part thereof for a regular vehicle.
  constraint ewb_distance check (distance_km between 1 and 4000),
  -- A consignment moves on a vehicle or under a transporter's docket.
  constraint ewb_carrier check (
    status = 'draft' or vehicle_no is not null or transporter_gstin is not null
  )
);

create unique index if not exists ewb_one_live_per_doc on eway_bill (tenant_id, source_doc, source_id)
  where status <> 'cancelled';
create unique index if not exists ewb_number_unique on eway_bill (tenant_id, ewb_no)
  where ewb_no is not null;
create index if not exists ewb_by_date on eway_bill (tenant_id, doc_date);

/** Validity in days, Rule 138(10): 1 day per 200 km or part thereof. */
create or replace function ewb_validity_days(km integer) returns integer
  language sql immutable as $$ select greatest(1, ceil(km::numeric / 200)::integer) $$;

-- ------------------------------------------------- Rule 55 delivery challan --

/**
 * Goods sent to a job worker move on a delivery challan, not an invoice.
 * `dyeing_issue` already holds the movement; this exposes it with every field
 * Rule 55(1) requires, so the printed document is compliant rather than a
 * screen-scrape of internal columns.
 */
create or replace view v_delivery_challan as
select di.tenant_id, di.id as issue_id, di.entry_no, di.challan_no, di.challan_date,
       di.lot_no, di.no_of_bales, di.vehicle_no, di.lr_no, di.status,
       t.legal_name as consignor_name, t.gstin as consignor_gstin,
       t.address1 as consignor_addr, t.city as consignor_city,
       t.pincode as consignor_pincode, t.state_code as consignor_state,
       ph.name as consignee_name, ph.gstin as consignee_gstin,
       a.line1 as consignee_addr, a.city as consignee_city,
       a.pincode as consignee_pincode, a.state_code as consignee_state,
       count(il.id)::int as pieces,
       sum(il.issued_qty) as total_qty,
       -- Rule 55(1)(e): the taxable value of the goods, even though sending
       -- them to a job worker is not itself a supply.
       round(sum(il.issued_qty * coalesce(p.grey_cost / nullif(p.grey_qty, 0), 0)), 2)
         as taxable_value
  from dyeing_issue di
  join tenant t on t.id = di.tenant_id
  join ledger_account ph on ph.id = di.process_house_id
  join dyeing_issue_line il on il.issue_id = di.id
  join piece p on p.id = il.piece_id
  left join lateral (
    select line1, city, pincode, state_code from ledger_address
     where ledger_id = ph.id order by is_primary desc limit 1
  ) a on true
 where di.tenant_id = current_setting('app.tenant_id', true)::uuid
 group by di.tenant_id, di.id, di.entry_no, di.challan_no, di.challan_date, di.lot_no,
          di.no_of_bales, di.vehicle_no, di.lr_no, di.status,
          t.legal_name, t.gstin, t.address1, t.city, t.pincode, t.state_code,
          ph.name, ph.gstin, a.line1, a.city, a.pincode, a.state_code;

/** The HSN-level detail Rule 55(1)(d) and the e-way bill item list both need. */
create or replace view v_delivery_challan_line as
select di.tenant_id, di.id as issue_id, q.hsn_code, q.name as quality,
       q.construction, min(il.sno) as sno,
       count(*)::int as pieces,
       sum(il.issued_qty) as qty,
       'MTR' as uom,
       round(sum(il.issued_qty * coalesce(p.grey_cost / nullif(p.grey_qty, 0), 0)), 2)
         as taxable_value,
       coalesce(h.gst_rate, 5) as gst_rate
  from dyeing_issue di
  join dyeing_issue_line il on il.issue_id = di.id
  join piece p on p.id = il.piece_id
  join quality q on q.id = p.quality_id
  left join hsn_code h on h.tenant_id = di.tenant_id and h.code = q.hsn_code
 where di.tenant_id = current_setting('app.tenant_id', true)::uuid
 group by di.tenant_id, di.id, q.hsn_code, q.name, q.construction, h.gst_rate;

-- ------------------------------------------------------------------ ITC-04 --

/** FY quarter label for a date: Apr-Jun is Q1. */
create or replace function fy_quarter(d date) returns text language sql immutable as $$
  select 'Q' || (((extract(month from d)::int + 8) % 12) / 3 + 1)::text
         || '-' || (case when extract(month from d)::int >= 4
                         then extract(year from d)::int
                         else extract(year from d)::int - 1 end)::text
$$;

/** ITC-04 Table 4: goods dispatched to a job worker during the period. */
create or replace view v_itc04_sent as
select di.tenant_id, fy_quarter(di.challan_date) as return_period,
       coalesce(ph.gstin, 'URP') as job_worker_gstin, ph.name as job_worker,
       di.challan_no, di.challan_date, q.hsn_code,
       'MTR' as uom,
       sum(il.issued_qty) as qty,
       round(sum(il.issued_qty * coalesce(p.grey_cost / nullif(p.grey_qty, 0), 0)), 2)
         as taxable_value,
       -- 1 = inputs, 2 = capital goods. Grey cloth is always an input.
       '1' as goods_type
  from dyeing_issue di
  join ledger_account ph on ph.id = di.process_house_id
  join dyeing_issue_line il on il.issue_id = di.id
  join piece p on p.id = il.piece_id
  join quality q on q.id = p.quality_id
 where di.status <> 'cancelled'
   and di.tenant_id = current_setting('app.tenant_id', true)::uuid
 group by di.tenant_id, fy_quarter(di.challan_date), ph.gstin, ph.name,
          di.challan_no, di.challan_date, q.hsn_code;

/** ITC-04 Table 5A: goods received back, referenced to the original challan. */
create or replace view v_itc04_received as
select dr.tenant_id, fy_quarter(dr.challan_date) as return_period,
       coalesce(ph.gstin, 'URP') as job_worker_gstin, ph.name as job_worker,
       di.challan_no as original_challan_no, di.challan_date as original_challan_date,
       dr.challan_no as jobworker_challan_no, dr.challan_date as jobworker_challan_date,
       q.hsn_code, 'MTR' as uom,
       sum(rl.received_qty) as qty,
       sum(il.issued_qty)   as sent_qty,
       round(sum(il.issued_qty - rl.received_qty), 2) as loss_qty,
       -- 1 = received back, 2 = supplied from the job worker's premises.
       '1' as nature_of_job
  from dyeing_receipt dr
  join dyeing_receipt_line rl on rl.receipt_id = dr.id
  join dyeing_issue_line il on il.id = rl.issue_line_id
  join dyeing_issue di on di.id = il.issue_id
  join ledger_account ph on ph.id = dr.process_house_id
  join piece p on p.id = rl.piece_id
  join quality q on q.id = p.quality_id
 where dr.status <> 'cancelled'
   and dr.tenant_id = current_setting('app.tenant_id', true)::uuid
 group by dr.tenant_id, fy_quarter(dr.challan_date), ph.gstin, ph.name,
          di.challan_no, di.challan_date, dr.challan_no, dr.challan_date, q.hsn_code;

/** What is still lying at a job worker past the 1-year limit of s.143(1). */
create or replace view v_itc04_pending as
select di.tenant_id, ph.name as job_worker, coalesce(ph.gstin, 'URP') as job_worker_gstin,
       di.challan_no, di.challan_date,
       count(*)::int as pieces,
       sum(il.issued_qty) as qty,
       (current_date - di.challan_date) as days_out,
       (current_date - di.challan_date) > 365 as beyond_one_year
  from dyeing_issue di
  join ledger_account ph on ph.id = di.process_house_id
  join dyeing_issue_line il on il.issue_id = di.id
  join piece p on p.id = il.piece_id
 where di.status <> 'cancelled'
   and p.status = 'issued_to_dyeing'
   and di.tenant_id = current_setting('app.tenant_id', true)::uuid
 group by di.tenant_id, ph.name, ph.gstin, di.challan_no, di.challan_date;

-- ------------------------------------------------------------- auth state --

/**
 * Revocation and login throttling were in-process Maps: a restart resurrected
 * every signed-out token and a second instance had its own counters. Both are
 * now shared state with an expiry the API prunes.
 */
create table if not exists revoked_token (
  jti        uuid primary key,
  revoked_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists revoked_token_expiry on revoked_token (expires_at);

create table if not exists login_attempt (
  attempt_key text primary key,
  attempts    integer not null default 1,
  first_at    timestamptz not null default now(),
  last_at     timestamptz not null default now()
);
create index if not exists login_attempt_first on login_attempt (first_at);

-- ------------------------------------------------------------ privileges --

do $$
declare t text;
begin
  foreach t in array array['gst_filing', 'eway_bill'] loop
    execute format('grant select, insert, update, delete on %I to link_erp_app', t);
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format(
      'create policy tenant_isolation on %I using (tenant_id = current_setting(''app.tenant_id'', true)::uuid)'
      || ' with check (tenant_id = current_setting(''app.tenant_id'', true)::uuid)', t);
  end loop;
end $$;

-- Auth state is deliberately not tenant-scoped: it is read before a tenant is chosen.
grant select, insert, update, delete on revoked_token, login_attempt to link_erp_app;

grant select on v_delivery_challan, v_delivery_challan_line,
                v_itc04_sent, v_itc04_received, v_itc04_pending to link_erp_app;
grant execute on function ewb_validity_days(integer), fy_quarter(date) to link_erp_app;
