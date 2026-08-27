-- The last few fields an order form carries in this trade.
--
-- Most of them turned out to be here already: ship-to, broker, transport,
-- delivery days and date, payment terms, vary percent, cut length, and the
-- cloth's construction and selvedge on the quality master. What was missing
-- is the party's own reference for the order, the deduction agreed on a line,
-- and delivery to one of a party's addresses rather than the party itself.

-- The buyer's or seller's own order number. A weaver rings up about "our
-- order 4471" and nobody could find it, because we only ever stored ours.
alter table grey_purchase_order  add column if not exists party_ref text not null default '';
alter table finish_sales_order   add column if not exists party_ref text not null default '';

-- Grey orders got delivery terms in the schema but sales orders never did.
alter table finish_sales_order   add column if not exists delivery_terms text not null default '';

/**
 * The deduction agreed when the order is placed, line by line — so many
 * metres or a percentage off for a known defect, short width, or a grade the
 * buyer accepts at a discount. Recorded on the order because that is when it
 * is agreed; the receipt or dispatch then has something to check against.
 */
do $$ begin
  if not exists (select 1 from pg_type where typname = 'less_type') then
    create type less_type as enum ('none', 'pcs', 'meters', 'percent');
  end if;
end $$;

alter table grey_purchase_order_line
  add column if not exists less_type less_type not null default 'none',
  add column if not exists less_value numeric(10,2) not null default 0;
alter table finish_sales_order_line
  add column if not exists less_type less_type not null default 'none',
  add column if not exists less_value numeric(10,2) not null default 0;

alter table grey_purchase_order_line drop constraint if exists po_less_consistent;
alter table grey_purchase_order_line add constraint po_less_consistent check (
  (less_type = 'none' and less_value = 0) or (less_type <> 'none' and less_value > 0)
);
alter table finish_sales_order_line drop constraint if exists so_less_consistent;
alter table finish_sales_order_line add constraint so_less_consistent check (
  (less_type = 'none' and less_value = 0) or (less_type <> 'none' and less_value > 0)
);

/**
 * Which of the party's addresses the goods go to. ledger_address already
 * holds them with an is_ship_to flag; the order could only name the party, so
 * a buyer with a Bhiwandi godown and a Surat office had no way to say which.
 */
alter table grey_purchase_order
  add column if not exists ship_to_address_id uuid references ledger_address(id);
alter table finish_sales_order
  add column if not exists ship_to_address_id uuid references ledger_address(id);

create index if not exists po_by_ship_address on grey_purchase_order (ship_to_address_id)
  where ship_to_address_id is not null;
create index if not exists so_by_ship_address on finish_sales_order (ship_to_address_id)
  where ship_to_address_id is not null;

-- Order lines as the form shows them: the cloth's own specification comes
-- from the quality master rather than being re-typed onto every line.
create or replace view v_order_line_spec as
select l.tenant_id, 'purchase'::text as side, o.id as order_id, o.order_no, o.order_date,
       o.party_ref, p.name as party, l.sno, q.name as quality, d.name as design, l.grade_code,
       q.construction, q.selvedge_line, q.width_cms,
       l.less_type::text as less_type, l.less_value,
       l.pcs, l.cut_length, l.qty, l.rate, l.amount,
       l.received_qty as done_qty, l.qty - l.received_qty as balance_qty
  from grey_purchase_order_line l
  join grey_purchase_order o on o.id = l.order_id
  join ledger_account p on p.id = o.party_id
  join quality q on q.id = l.quality_id
  left join design d on d.id = l.design_id
 where l.tenant_id = current_setting('app.tenant_id', true)::uuid
union all
select l.tenant_id, 'sales', o.id, o.order_no, o.order_date,
       o.party_ref, p.name, l.sno, q.name, d.name, l.grade_code,
       q.construction, q.selvedge_line, q.width_cms,
       l.less_type::text, l.less_value,
       l.pcs, l.cut_length, l.qty, l.rate, l.amount,
       l.dispatched_qty, l.qty - l.dispatched_qty
  from finish_sales_order_line l
  join finish_sales_order o on o.id = l.order_id
  join ledger_account p on p.id = o.party_id
  join quality q on q.id = l.quality_id
  left join design d on d.id = l.design_id
 where l.tenant_id = current_setting('app.tenant_id', true)::uuid;

grant select on v_order_line_spec to link_erp_app;
