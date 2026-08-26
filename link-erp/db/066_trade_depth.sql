-- The trade details a converter's customer actually holds in their hands.
--
-- Four gaps, all found by watching the incumbent this mill runs today rather
-- than by reasoning about what an ERP ought to have:
--
--   * a bale number per thaan, because the customer opens bale three and needs
--     to know what is inside it;
--   * the customer's own name for a quality, because they do not call it what
--     we call it and their challan must read in their language;
--   * a real division master, because it was free text and free text does not
--     group a stock report;
--   * a barcode scope for a stock count, so re-measuring one thaan does not
--     require opening a count of the whole rack.
--
-- The fourth is the interesting one. A quick re-measure is exactly the kind of
-- thing that grows into an "adjust stock" back door. It gets none: it opens a
-- stock count scoped to one barcode and goes through the same snapshot,
-- variance, reason, approval and voucher as a count of the whole godown.

-- ----------------------------------------------------------------- bales --

alter table dispatch_line add column if not exists bale_no smallint;
alter table dispatch_line drop constraint if exists dispatch_line_bale_sane;
alter table dispatch_line add constraint dispatch_line_bale_sane
  check (bale_no is null or bale_no between 1 and 9999);

create index if not exists dispatch_line_by_bale
  on dispatch_line (dispatch_id, bale_no) where bale_no is not null;

/** The packing list the way it is actually loaded: one section per bale. */
create view v_dispatch_bale as
select dl.tenant_id, dl.dispatch_id, d.challan_no, d.challan_date,
       coalesce(dl.bale_no, 0) as bale_no,
       count(*)::int as pieces,
       sum(dl.qty) as qty,
       sum(dl.qty * dl.rate) as value,
       string_agg(p.barcode, ', ' order by p.barcode) as barcodes,
       string_agg(distinct q.name, ', ') as qualities
  from dispatch_line dl
  join dispatch d on d.id = dl.dispatch_id
  join piece p on p.id = dl.piece_id
  join quality q on q.id = p.quality_id
 where dl.tenant_id = current_setting('app.tenant_id', true)::uuid
 group by dl.tenant_id, dl.dispatch_id, d.challan_no, d.challan_date, coalesce(dl.bale_no, 0);

-- ------------------------------------------------- the customer's own words --

/**
 * What this party calls our quality and design. A trader sells the same cloth
 * to three customers under three names, and a challan that prints ours makes
 * the customer's storekeeper reconcile by hand.
 *
 * Design is optional: an alias may cover a whole quality, or one design within
 * it. The partial unique indexes below give "one alias per scope" for both.
 */
create table party_item_alias (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenant(id) on delete cascade,
  party_id       uuid not null references ledger_account(id) on delete cascade,
  quality_id     uuid not null references quality(id) on delete cascade,
  design_id      uuid references design(id) on delete cascade,
  their_quality  text not null default '',
  their_design   text not null default '',
  notes          text not null default '',
  created_at     timestamptz not null default now(),
  created_by     uuid references app_user(id),
  constraint alias_says_something
    check (length(btrim(their_quality)) > 0 or length(btrim(their_design)) > 0)
);

create unique index party_alias_quality_scope
  on party_item_alias (tenant_id, party_id, quality_id) where design_id is null;
create unique index party_alias_design_scope
  on party_item_alias (tenant_id, party_id, quality_id, design_id) where design_id is not null;
create index party_alias_by_party on party_item_alias (tenant_id, party_id);
create index party_alias_by_quality on party_item_alias (quality_id);
create index party_alias_by_design on party_item_alias (design_id);
create index party_alias_by_creator on party_item_alias (created_by);

/**
 * Resolves what to print for one party and one item. A design-specific alias
 * beats a quality-wide one; with neither, our own name is returned, so every
 * caller can use this unconditionally.
 */
create or replace function party_item_name(
  p_party uuid, p_quality uuid, p_design uuid
) returns table (their_quality text, their_design text)
language sql stable as $$
  select
    coalesce(nullif(a.their_quality, ''), q.name),
    coalesce(nullif(a.their_design, ''), d.name, '')
    from quality q
    left join design d on d.id = p_design
    left join lateral (
      select * from party_item_alias x
       where x.party_id = p_party and x.quality_id = p_quality
         and (x.design_id = p_design or x.design_id is null)
       order by x.design_id nulls last
       limit 1
    ) a on true
   where q.id = p_quality;
$$;

-- ------------------------------------------------------------- divisions --

/** Shirting, suiting, and whatever else this mill sells. */
create table division (
  tenant_id  uuid not null references tenant(id) on delete cascade,
  code       text not null,
  name       text not null,
  sort_order smallint not null default 0,
  is_active  boolean not null default true,
  primary key (tenant_id, code)
);

-- Whatever was already typed into the free-text column becomes the first set of
-- divisions, so nothing a mill has entered is lost on the way to a real master.
insert into division (tenant_id, code, name)
select distinct q.tenant_id, btrim(q.division), btrim(q.division)
  from quality q
 where btrim(coalesce(q.division, '')) <> ''
on conflict (tenant_id, code) do nothing;

alter table quality add column if not exists division_code text;
update quality set division_code = btrim(division)
 where btrim(coalesce(division, '')) <> '' and division_code is null;

alter table quality drop constraint if exists quality_division_known;
alter table quality add constraint quality_division_known
  foreign key (tenant_id, division_code) references division (tenant_id, code);
create index if not exists quality_by_division
  on quality (tenant_id, division_code) where division_code is not null;

-- ------------------------------------------------ a count of one barcode --

/**
 * Scoping a count to a single thaan. Everything else about a stock count is
 * unchanged — the snapshot is still frozen, the difference still needs an
 * outcome and a reason, a second person still approves it, and the movement
 * and the voucher still post together.
 */
alter table stock_count add column if not exists barcode text;
comment on column stock_count.barcode is
  'When set, the count covers exactly this thaan: a floor re-measure rather than a rack.';

do $$
declare t text;
begin
  foreach t in array array['party_item_alias', 'division'] loop
    execute format('grant select, insert, update, delete on %I to link_erp_app', t);
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format(
      'create policy tenant_isolation on %I using (tenant_id = current_setting(''app.tenant_id'', true)::uuid)'
      || ' with check (tenant_id = current_setting(''app.tenant_id'', true)::uuid)', t);
  end loop;
end $$;

grant select on v_dispatch_bale to link_erp_app;
grant execute on function party_item_name(uuid, uuid, uuid) to link_erp_app;
