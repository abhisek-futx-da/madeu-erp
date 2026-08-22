-- Per-mill variation as data, not code. Every rule here is something the ten
-- mills we onboard will each want differently; if these were branches in the
-- source we would end up with ten forks nobody can merge.

create table tenant_setting (
  tenant_id   uuid not null references tenant(id) on delete cascade,
  key         text not null,
  value       jsonb not null,
  updated_at  timestamptz not null default now(),
  primary key (tenant_id, key)
);

-- Shrinkage tolerance. The most specific matching row wins: quality plus
-- process house, then either alone, then the tenant default.
create table shrinkage_policy (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenant(id) on delete cascade,
  quality_id        uuid references quality(id) on delete cascade,
  process_house_id  uuid references ledger_account(id) on delete cascade,
  warn_pct          numeric(5,2) not null default 8,
  max_pct           numeric(5,2) not null default 12,
  gain_pct          numeric(5,2) not null default 1,
  constraint shrinkage_bounds check (warn_pct <= max_pct and max_pct <= 100 and gain_pct >= 0)
);
create unique index shrinkage_policy_scope
  on shrinkage_policy (tenant_id, coalesce(quality_id, '00000000-0000-0000-0000-000000000000'::uuid),
                       coalesce(process_house_id, '00000000-0000-0000-0000-000000000000'::uuid));

create type brokerage_basis as enum ('percent_of_value', 'per_unit', 'flat');

create table brokerage_rule (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenant(id) on delete cascade,
  broker_id   uuid not null references ledger_account(id) on delete cascade,
  party_id    uuid references ledger_account(id) on delete cascade,
  doc_type    text not null,
  basis       brokerage_basis not null default 'percent_of_value',
  rate        numeric(10,4) not null,
  constraint brokerage_rate_sane check (rate >= 0)
);
create unique index brokerage_rule_scope
  on brokerage_rule (tenant_id, broker_id, doc_type,
                     coalesce(party_id, '00000000-0000-0000-0000-000000000000'::uuid));

/**
 * Resolves the shrinkage policy for a quality at a process house, most
 * specific first. Returns the tenant default when nothing more specific exists.
 */
create or replace function shrinkage_policy_for(
  p_tenant uuid, p_quality uuid, p_process_house uuid
) returns table (warn_pct numeric, max_pct numeric, gain_pct numeric)
language sql stable as $$
  select warn_pct, max_pct, gain_pct
    from shrinkage_policy
   where tenant_id = p_tenant
     and (quality_id = p_quality or quality_id is null)
     and (process_house_id = p_process_house or process_house_id is null)
   order by (quality_id is not null)::int + (process_house_id is not null)::int desc
   limit 1;
$$;

-- ------------------------------------------------------- inward documents --

-- Purchases carry tax too; without this there is no input credit to claim.
create table purchase_invoice (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenant(id) on delete cascade,
  our_ref           text not null,
  supplier_invoice_no text not null,
  invoice_date      date not null,
  party_id          uuid not null references ledger_account(id),
  source_doc        text,
  source_id         uuid,
  place_of_supply   char(2) not null,
  supply_type       supply_type not null,
  is_rcm            boolean not null default false,
  taxable_value     numeric(14,2) not null default 0,
  cgst_amount       numeric(14,2) not null default 0,
  sgst_amount       numeric(14,2) not null default 0,
  igst_amount       numeric(14,2) not null default 0,
  round_off         numeric(6,2)  not null default 0,
  invoice_total     numeric(14,2) not null default 0,
  itc_eligible      boolean not null default true,
  voucher_id        uuid references voucher(id),
  status            doc_status not null default 'draft',
  created_at        timestamptz not null default now(),
  created_by        uuid references app_user(id),
  unique (tenant_id, our_ref),
  unique (tenant_id, party_id, supplier_invoice_no, invoice_date),
  constraint purchase_tax_legs_consistent check (
    (supply_type = 'intra_state' and igst_amount = 0)
    or (supply_type <> 'intra_state' and cgst_amount = 0 and sgst_amount = 0)
  ),
  constraint purchase_total_adds_up check (
    invoice_total = taxable_value + cgst_amount + sgst_amount + igst_amount + round_off
  )
);

create table purchase_invoice_line (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenant(id) on delete cascade,
  invoice_id      uuid not null references purchase_invoice(id) on delete cascade,
  sno             smallint not null,
  hsn_code        text not null,
  description     text not null,
  qty             numeric(12,2) not null,
  uom             text not null default 'MTR',
  rate            numeric(10,2) not null,
  taxable_value   numeric(14,2) not null,
  gst_rate        numeric(5,2) not null,
  cgst_amount     numeric(14,2) not null default 0,
  sgst_amount     numeric(14,2) not null default 0,
  igst_amount     numeric(14,2) not null default 0,
  line_total      numeric(14,2) not null,
  unique (invoice_id, sno)
);

create type note_kind as enum ('credit', 'debit');

-- Credit and debit notes against an already-issued tax invoice.
create table gst_note (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenant(id) on delete cascade,
  note_no           text not null,
  note_kind         note_kind not null,
  note_date         date not null,
  against_invoice_id uuid not null references sales_invoice(id),
  party_id          uuid not null references ledger_account(id),
  reason            text not null,
  place_of_supply   char(2) not null,
  supply_type       supply_type not null,
  taxable_value     numeric(14,2) not null,
  cgst_amount       numeric(14,2) not null default 0,
  sgst_amount       numeric(14,2) not null default 0,
  igst_amount       numeric(14,2) not null default 0,
  note_total        numeric(14,2) not null,
  voucher_id        uuid references voucher(id),
  created_at        timestamptz not null default now(),
  created_by        uuid references app_user(id),
  unique (tenant_id, note_no),
  constraint note_positive check (taxable_value >= 0 and note_total >= 0)
);

-- ------------------------------------------------------------ privileges --

do $$
declare t text;
begin
  foreach t in array array[
    'tenant_setting','shrinkage_policy','brokerage_rule',
    'purchase_invoice','purchase_invoice_line','gst_note'
  ] loop
    execute format('grant select, insert, update, delete on %I to link_erp_app', t);
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy tenant_isolation on %I using (tenant_id = current_setting(''app.tenant_id'', true)::uuid)'
      || ' with check (tenant_id = current_setting(''app.tenant_id'', true)::uuid)', t);
  end loop;
end $$;

grant execute on function shrinkage_policy_for(uuid, uuid, uuid) to link_erp_app;
