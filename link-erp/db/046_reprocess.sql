-- Re-dyeing/re-finishing is not a vendor return.  The mill still owns the
-- cloth while the process house corrects it, and only the incremental job
-- charge is added when it comes back.

alter type piece_status add value if not exists 'reprocess_at_process_house';
alter type movement_event add value if not exists 'send_reprocess';
alter type movement_event add value if not exists 'receive_reprocess';

insert into piece_status_transition (from_status, to_status) values
  ('received_finish', 'reprocess_at_process_house'),
  ('reprocess_at_process_house', 'received_finish')
on conflict do nothing;

create table dyeing_reprocess (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenant(id) on delete cascade,
  issue_no          text not null,
  issue_date        date not null,
  process_house_id  uuid not null references ledger_account(id),
  challan_no        text not null,
  challan_date      date not null,
  reason            text not null,
  status            doc_status not null default 'approved',
  created_by        uuid not null references app_user(id),
  created_at        timestamptz not null default now(),
  unique (tenant_id, issue_no),
  unique (tenant_id, process_house_id, challan_no, challan_date)
);

create table dyeing_reprocess_line (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenant(id) on delete cascade,
  reprocess_id   uuid not null references dyeing_reprocess(id) on delete cascade,
  piece_id       uuid not null references piece(id),
  sno            smallint not null,
  issued_qty     numeric(10,2) not null,
  original_grade text not null,
  unique (reprocess_id, sno),
  unique (reprocess_id, piece_id),
  constraint reprocess_issue_qty_positive check (issued_qty > 0)
);

create table dyeing_reprocess_receipt (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  reprocess_id  uuid not null references dyeing_reprocess(id),
  receipt_no    text not null,
  receipt_date  date not null,
  challan_no    text not null,
  challan_date  date not null,
  remarks       text not null default '',
  amount        numeric(14,2) not null default 0,
  status        doc_status not null default 'approved',
  voucher_id    uuid references voucher(id),
  created_by    uuid not null references app_user(id),
  created_at    timestamptz not null default now(),
  unique (tenant_id, receipt_no),
  unique (tenant_id, reprocess_id, challan_no, challan_date)
);

create table dyeing_reprocess_receipt_line (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenant(id) on delete cascade,
  receipt_id         uuid not null references dyeing_reprocess_receipt(id) on delete cascade,
  reprocess_line_id  uuid not null references dyeing_reprocess_line(id),
  piece_id           uuid not null references piece(id),
  sno                smallint not null,
  issued_qty         numeric(10,2) not null,
  received_qty       numeric(10,2) not null,
  additional_rate    numeric(10,2) not null,
  additional_amount  numeric(14,2) generated always as (received_qty * additional_rate) stored,
  finish_grade       text not null,
  unique (receipt_id, sno),
  unique (receipt_id, piece_id),
  constraint reprocess_receipt_values check (
    issued_qty > 0 and received_qty > 0 and additional_rate >= 0
  )
);

create index reprocess_by_house_date on dyeing_reprocess(tenant_id, process_house_id, issue_date desc);
create index reprocess_line_piece on dyeing_reprocess_line(piece_id);
create index reprocess_receipt_by_reprocess on dyeing_reprocess_receipt(reprocess_id, receipt_date desc);
create index reprocess_receipt_line_source on dyeing_reprocess_receipt_line(reprocess_line_id);
create index reprocess_receipt_line_piece on dyeing_reprocess_receipt_line(piece_id);

grant select, insert, update, delete on
  dyeing_reprocess, dyeing_reprocess_line,
  dyeing_reprocess_receipt, dyeing_reprocess_receipt_line to link_erp_app;

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'dyeing_reprocess','dyeing_reprocess_line',
    'dyeing_reprocess_receipt','dyeing_reprocess_receipt_line'
  ] loop
    execute format('alter table %I enable row level security', table_name);
    execute format(
      'create policy tenant_isolation on %I using (tenant_id = current_setting(''app.tenant_id'', true)::uuid)'
      || ' with check (tenant_id = current_setting(''app.tenant_id'', true)::uuid)', table_name);
  end loop;
end $$;

-- Numbering exists for both current companies and companies bootstrapped after
-- this migration.  The service never invents a number outside document_series.
insert into document_series (tenant_id, doc_type, fy_label, prefix, next_number)
select fy.tenant_id, d.doc_type, fy.label,
       d.prefix || right(fy.label, 5) || '/', 1
  from financial_year fy
  cross join (values
    ('dyeing_reprocess', 'RP/'),
    ('dyeing_reprocess_receipt', 'RR/')
  ) as d(doc_type, prefix)
on conflict (tenant_id, doc_type, fy_label) do nothing;

-- Incremental job-work is a financial exception: a second named person must
-- release it.  This is a new class, so enabling it cannot hold old documents.
alter table approval_rule drop constraint if exists approval_doc_type;
alter table approval_rule add constraint approval_doc_type check (doc_type in (
  'sales_invoice', 'purchase_invoice', 'payment', 'stock_count',
  'grey_return', 'dyeing_return', 'customer_return', 'write_off',
  'dyeing_reprocess_receipt'
));

insert into approval_rule (tenant_id, doc_type, min_amount, approver_role, is_active)
select id, 'dyeing_reprocess_receipt', 0, 'owner', true from tenant
on conflict (tenant_id, doc_type) do nothing;

-- The normal approval queue, with the new receipt charge visible alongside
-- every other held posting.
create or replace view v_pending_approvals as
select 'sales_invoice'::text doc_type, i.id doc_id, i.invoice_no doc_no, i.invoice_date doc_date,
       i.invoice_total amount, p.name party, i.created_by raised_by, u.full_name raised_by_name,
       i.created_at, r.approver_role, r.min_amount, current_date - i.invoice_date waiting_days, i.tenant_id
  from sales_invoice i join ledger_account p on p.id = i.party_id
  left join app_user u on u.id = i.created_by
  left join approval_rule r on r.tenant_id = i.tenant_id and r.doc_type = 'sales_invoice'
 where i.status = 'pending_approval' and i.tenant_id = current_setting('app.tenant_id', true)::uuid
union all
select 'purchase_invoice', pi.id, pi.our_ref, pi.invoice_date, pi.invoice_total, l.name, pi.created_by, u.full_name,
       pi.created_at, r.approver_role, r.min_amount, current_date - pi.invoice_date, pi.tenant_id
  from purchase_invoice pi join ledger_account l on l.id = pi.party_id
  left join app_user u on u.id = pi.created_by
  left join approval_rule r on r.tenant_id = pi.tenant_id and r.doc_type = 'purchase_invoice'
 where pi.status = 'pending_approval' and pi.tenant_id = current_setting('app.tenant_id', true)::uuid
union all
select 'payment', p.id, p.voucher_no, p.payment_date, p.amount, l.name, p.created_by, u.full_name,
       p.created_at, r.approver_role, r.min_amount, current_date - p.payment_date, p.tenant_id
  from payment p join ledger_account l on l.id = p.party_id
  left join app_user u on u.id = p.created_by
  left join approval_rule r on r.tenant_id = p.tenant_id and r.doc_type = 'payment'
 where p.status = 'pending_approval' and p.tenant_id = current_setting('app.tenant_id', true)::uuid
union all
select 'stock_count', s.id, s.count_no, s.count_date, s.net_value, coalesce('Rack ' || s.rack_code, 'Everywhere'),
       s.created_by, u.full_name, s.created_at, r.approver_role, r.min_amount, current_date - s.count_date, s.tenant_id
  from stock_count s left join app_user u on u.id = s.created_by
  left join approval_rule r on r.tenant_id = s.tenant_id and r.doc_type = 'stock_count'
 where s.status = 'pending_approval' and s.tenant_id = current_setting('app.tenant_id', true)::uuid
union all
select 'grey_return', gr.id, gr.entry_no, gr.entry_date, gr.amount, l.name, gr.created_by, u.full_name,
       gr.created_at, r.approver_role, r.min_amount, current_date - gr.entry_date, gr.tenant_id
  from grey_return gr join ledger_account l on l.id = gr.weaver_id
  left join app_user u on u.id = gr.created_by
  left join approval_rule r on r.tenant_id = gr.tenant_id and r.doc_type = 'grey_return'
 where gr.status = 'pending_approval' and gr.tenant_id = current_setting('app.tenant_id', true)::uuid
union all
select 'dyeing_return', dr.id, dr.entry_no, dr.entry_date, dr.amount, l.name, dr.created_by, u.full_name,
       dr.created_at, r.approver_role, r.min_amount, current_date - dr.entry_date, dr.tenant_id
  from dyeing_return dr join ledger_account l on l.id = dr.process_house_id
  left join app_user u on u.id = dr.created_by
  left join approval_rule r on r.tenant_id = dr.tenant_id and r.doc_type = 'dyeing_return'
 where dr.status = 'pending_approval' and dr.tenant_id = current_setting('app.tenant_id', true)::uuid
union all
select 'customer_return', cr.id, cr.entry_no, cr.entry_date, cr.amount, l.name, cr.created_by, u.full_name,
       cr.created_at, r.approver_role, r.min_amount, current_date - cr.entry_date, cr.tenant_id
  from customer_return cr join ledger_account l on l.id = cr.customer_id
  left join app_user u on u.id = cr.created_by
  left join approval_rule r on r.tenant_id = cr.tenant_id and r.doc_type = 'customer_return'
 where cr.status = 'pending_approval' and cr.tenant_id = current_setting('app.tenant_id', true)::uuid
union all
select 'write_off', wo.id, wo.entry_no, wo.entry_date, wo.amount, 'Internal', wo.created_by, u.full_name,
       wo.created_at, r.approver_role, r.min_amount, current_date - wo.entry_date, wo.tenant_id
  from write_off wo left join app_user u on u.id = wo.created_by
  left join approval_rule r on r.tenant_id = wo.tenant_id and r.doc_type = 'write_off'
 where wo.status = 'pending_approval' and wo.tenant_id = current_setting('app.tenant_id', true)::uuid
union all
select 'dyeing_reprocess_receipt', rr.id, rr.receipt_no, rr.receipt_date, rr.amount,
       l.name, rr.created_by, u.full_name, rr.created_at, ar.approver_role, ar.min_amount,
       current_date - rr.receipt_date, rr.tenant_id
  from dyeing_reprocess_receipt rr
  join dyeing_reprocess rp on rp.id = rr.reprocess_id
  join ledger_account l on l.id = rp.process_house_id
  left join app_user u on u.id = rr.created_by
  left join approval_rule ar on ar.tenant_id = rr.tenant_id and ar.doc_type = 'dyeing_reprocess_receipt'
 where rr.status = 'pending_approval'
   and rr.tenant_id = current_setting('app.tenant_id', true)::uuid;

grant select on v_pending_approvals to link_erp_app;

-- Process-house custody includes first processing and reprocessing.  The stage
-- is explicit so the owner can reconcile each pile independently.
create or replace view v_process_stock as
select p.tenant_id, l.name as process_house, q.name as quality,
       count(*) as pcs, sum(p.current_qty) as qty,
       case p.status
         when 'issued_to_dyeing' then 'First process'
         when 'reprocess_at_process_house' then 'Reprocess'
       end as stage
  from piece p
  join ledger_account l on l.id = p.held_by_ledger_id
  join quality q on q.id = p.quality_id
 where p.status in ('issued_to_dyeing','reprocess_at_process_house')
   and p.tenant_id = current_setting('app.tenant_id', true)::uuid
 group by p.tenant_id, l.name, q.name, p.status;

-- Reprocess cloth is still owned inventory; it cannot disappear from the
-- valuation report while physically lying at the processor.
create or replace view v_stock_valuation as
select p.tenant_id, p.status, q.name as quality, g.name as grade,
       count(*)                                          as pcs,
       sum(p.current_qty)                                as qty,
       sum(p.grey_cost)                                  as grey_cost,
       sum(p.jobwork_cost)                               as jobwork_cost,
       sum(p.grey_cost + p.jobwork_cost + p.other_cost)  as total_cost,
       round(sum(p.grey_cost + p.jobwork_cost + p.other_cost)
             / nullif(sum(p.current_qty), 0), 2)         as cost_per_mtr
  from piece p
  join quality q on q.id = p.quality_id
  join grade g on g.tenant_id = p.tenant_id and g.code = p.grade_code
 where p.status in ('grey_in_stock','issued_to_dyeing','received_finish','cut_packed','reprocess_at_process_house')
   and p.tenant_id = current_setting('app.tenant_id', true)::uuid
 group by p.tenant_id, p.status, q.name, g.name;
