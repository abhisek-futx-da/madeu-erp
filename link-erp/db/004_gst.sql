-- GST: tax invoices, per-line tax breakdown, and explicit posting roles.
-- Place of supply decides intra-state (CGST+SGST) vs inter-state (IGST); that
-- decision is stored on the invoice, never recomputed from live master data.

-- ------------------------------------------------------- explicit posting --

-- Replaces "resolve the ledger by control-account nature and hope there is
-- only one". A posting role names exactly one ledger per tenant.
create type posting_role as enum (
  'purchase_grey','purchase_jobwork','sales_finish',
  'cgst_output','sgst_output','igst_output',
  'cgst_input','sgst_input','igst_input',
  'round_off','rcm_liability'
);

alter table ledger_account add column posting_role posting_role;
create unique index ledger_one_per_posting_role
  on ledger_account (tenant_id, posting_role) where posting_role is not null;

-- ------------------------------------------------------------- documents --

create type supply_type as enum ('intra_state','inter_state','export','sez');

create table sales_invoice (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenant(id) on delete cascade,
  invoice_no        text not null,
  invoice_date      date not null,
  party_id          uuid not null references ledger_account(id),
  dispatch_id       uuid references dispatch(id),
  place_of_supply   char(2) not null,
  supply_type       supply_type not null,
  is_rcm            boolean not null default false,
  taxable_value     numeric(14,2) not null default 0,
  cgst_amount       numeric(14,2) not null default 0,
  sgst_amount       numeric(14,2) not null default 0,
  igst_amount       numeric(14,2) not null default 0,
  round_off         numeric(6,2)  not null default 0,
  invoice_total     numeric(14,2) not null default 0,
  voucher_id        uuid references voucher(id),
  status            doc_status not null default 'draft',
  created_at        timestamptz not null default now(),
  created_by        uuid references app_user(id),
  unique (tenant_id, invoice_no),
  -- One leg or the other, never both: the core GST invariant.
  constraint tax_legs_consistent check (
    (supply_type = 'intra_state' and igst_amount = 0)
    or (supply_type <> 'intra_state' and cgst_amount = 0 and sgst_amount = 0)
  ),
  constraint cgst_equals_sgst check (cgst_amount = sgst_amount),
  constraint total_adds_up check (
    invoice_total = taxable_value + cgst_amount + sgst_amount + igst_amount + round_off
  )
);

create table sales_invoice_line (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenant(id) on delete cascade,
  invoice_id      uuid not null references sales_invoice(id) on delete cascade,
  sno             smallint not null,
  piece_id        uuid references piece(id),
  quality_id      uuid not null references quality(id),
  hsn_code        text not null,
  description     text not null,
  qty             numeric(12,2) not null,
  uom             text not null default 'MTR',
  rate            numeric(10,2) not null,
  discount        numeric(12,2) not null default 0,
  taxable_value   numeric(14,2) not null,
  gst_rate        numeric(5,2) not null,
  cgst_rate       numeric(5,2) not null default 0,
  cgst_amount     numeric(14,2) not null default 0,
  sgst_rate       numeric(5,2) not null default 0,
  sgst_amount     numeric(14,2) not null default 0,
  igst_rate       numeric(5,2) not null default 0,
  igst_amount     numeric(14,2) not null default 0,
  line_total      numeric(14,2) not null,
  unique (invoice_id, sno),
  constraint line_taxable_value_sane check (taxable_value >= 0),
  constraint line_split_is_half check (cgst_rate = sgst_rate)
);

create index sales_invoice_by_date on sales_invoice (tenant_id, invoice_date);
create index sales_invoice_line_by_hsn on sales_invoice_line (tenant_id, hsn_code);

-- gst_document currently hangs off a voucher; an IRN belongs to an invoice.
alter table gst_document add column invoice_id uuid references sales_invoice(id);
alter table gst_document alter column voucher_id drop not null;
alter table gst_document add column payload jsonb;
alter table gst_document add column eway_distance_km integer;
alter table gst_document add column cancelled_at timestamptz;
alter table gst_document add column cancel_reason text;

-- --------------------------------------------------------------- reports --

-- GSTR-1 B2B: one row per invoice per rate slab, which is how the return is filed.
create view v_gstr1_b2b as
select i.tenant_id,
       to_char(i.invoice_date, 'MM-YYYY')      as return_period,
       p.gstin                                  as recipient_gstin,
       p.name                                   as recipient_name,
       i.invoice_no, i.invoice_date, i.invoice_total,
       i.place_of_supply, i.supply_type, i.is_rcm,
       l.gst_rate,
       sum(l.taxable_value) as taxable_value,
       sum(l.cgst_amount)   as cgst_amount,
       sum(l.sgst_amount)   as sgst_amount,
       sum(l.igst_amount)   as igst_amount
  from sales_invoice i
  join sales_invoice_line l on l.invoice_id = i.id
  join ledger_account p on p.id = i.party_id
 where i.status <> 'cancelled'
   and p.gstin is not null
   and i.tenant_id = current_setting('app.tenant_id', true)::uuid
 group by i.tenant_id, i.invoice_no, i.invoice_date, i.invoice_total,
          i.place_of_supply, i.supply_type, i.is_rcm, p.gstin, p.name, l.gst_rate;

create view v_gstr1_hsn as
select i.tenant_id,
       to_char(i.invoice_date, 'MM-YYYY') as return_period,
       l.hsn_code, l.uom, l.gst_rate,
       sum(l.qty)            as total_qty,
       sum(l.taxable_value)  as taxable_value,
       sum(l.cgst_amount)    as cgst_amount,
       sum(l.sgst_amount)    as sgst_amount,
       sum(l.igst_amount)    as igst_amount
  from sales_invoice i
  join sales_invoice_line l on l.invoice_id = i.id
 where i.status <> 'cancelled'
   and i.tenant_id = current_setting('app.tenant_id', true)::uuid
 group by i.tenant_id, return_period, l.hsn_code, l.uom, l.gst_rate;

-- GSTR-3B table 3.1(a): outward taxable supplies, one row per period.
create view v_gstr3b_outward as
select i.tenant_id,
       to_char(i.invoice_date, 'MM-YYYY') as return_period,
       sum(i.taxable_value) as taxable_value,
       sum(i.cgst_amount)   as cgst_amount,
       sum(i.sgst_amount)   as sgst_amount,
       sum(i.igst_amount)   as igst_amount,
       count(*)             as invoice_count
  from sales_invoice i
 where i.status <> 'cancelled'
   and i.tenant_id = current_setting('app.tenant_id', true)::uuid
 group by i.tenant_id, return_period;

create view v_einvoice_pending as
select i.tenant_id, i.id as invoice_id, i.invoice_no, i.invoice_date,
       i.invoice_total, p.name as party_name, p.gstin,
       g.irn, g.filing_status, g.last_error
  from sales_invoice i
  join ledger_account p on p.id = i.party_id
  left join gst_document g on g.invoice_id = i.id
 where i.status <> 'cancelled'
   and (g.irn is null or g.filing_status <> 'accepted')
   and i.tenant_id = current_setting('app.tenant_id', true)::uuid;

-- ------------------------------------------------------------ privileges --

do $$
declare t text;
begin
  foreach t in array array['sales_invoice','sales_invoice_line'] loop
    execute format('grant select, insert, update, delete on %I to link_erp_app', t);
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy tenant_isolation on %I using (tenant_id = current_setting(''app.tenant_id'', true)::uuid)'
      || ' with check (tenant_id = current_setting(''app.tenant_id'', true)::uuid)', t);
  end loop;
end $$;

grant select on v_gstr1_b2b, v_gstr1_hsn, v_gstr3b_outward, v_einvoice_pending
  to link_erp_app;
