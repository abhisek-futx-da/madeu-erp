create table write_off (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenant(id),
  entry_no    text not null,
  entry_date  date not null,
  reason      text not null,
  status      doc_status not null default 'draft',
  created_at  timestamptz not null default now(),
  created_by  uuid not null references app_user(id),
  voucher_id  uuid references voucher(id),
  unique (tenant_id, entry_no)
);

create table write_off_line (
  id          uuid primary key default gen_random_uuid(),
  write_off_id uuid not null references write_off(id) on delete cascade,
  piece_id    uuid not null references piece(id),
  value       numeric(14,2) not null,
  unique (write_off_id, piece_id)
);

insert into piece_status_transition (from_status, to_status) values
  ('grey_in_stock', 'written_off'),
  ('received_finish', 'written_off')
on conflict do nothing;

create index write_off_by_date on write_off (tenant_id, entry_date desc, entry_no desc);

grant select, insert, update on write_off, write_off_line to link_erp_app;


create or replace view v_pending_approvals as
select 'sales_invoice' as doc_type, i.id as doc_id, i.invoice_no as doc_no,
       i.invoice_date as doc_date, i.invoice_total as amount,
       p.name as party, i.created_by as raised_by, u.full_name as raised_by_name,
       i.created_at, r.approver_role, r.min_amount,
       (current_date - i.invoice_date) as waiting_days, i.tenant_id
  from sales_invoice i
  join ledger_account p on p.id = i.party_id
  left join app_user u on u.id = i.created_by
  left join approval_rule r on r.tenant_id = i.tenant_id and r.doc_type = 'sales_invoice'
 where i.status = 'pending_approval'
   and i.tenant_id = current_setting('app.tenant_id', true)::uuid

union all

select 'purchase_invoice', pi.id, pi.our_ref, pi.invoice_date, pi.invoice_total,
       l.name, pi.created_by, u.full_name, pi.created_at, r.approver_role, r.min_amount,
       (current_date - pi.invoice_date), pi.tenant_id
  from purchase_invoice pi
  join ledger_account l on l.id = pi.party_id
  left join app_user u on u.id = pi.created_by
  left join approval_rule r on r.tenant_id = pi.tenant_id and r.doc_type = 'purchase_invoice'
 where pi.status = 'pending_approval'
   and pi.tenant_id = current_setting('app.tenant_id', true)::uuid

union all

select 'payment', pay.id, pay.voucher_no, pay.payment_date, pay.amount,
       l.name, pay.created_by, u.full_name, pay.created_at, r.approver_role, r.min_amount,
       (current_date - pay.payment_date), pay.tenant_id
  from payment pay
  join ledger_account l on l.id = pay.party_id
  left join app_user u on u.id = pay.created_by
  left join approval_rule r on r.tenant_id = pay.tenant_id and r.doc_type = 'payment'
 where pay.status = 'pending_approval'
   and pay.tenant_id = current_setting('app.tenant_id', true)::uuid

union all

select 'stock_count', sc.id, sc.count_no, sc.count_date,
       coalesce((select abs(sum(value)) from stock_count_variance where count_id = sc.id), 0)::numeric(14,2),
       coalesce('Rack ' || sc.rack_code, 'Everywhere'), sc.created_by, u.full_name, sc.created_at, r.approver_role, r.min_amount,
       (current_date - sc.count_date), sc.tenant_id
  from stock_count sc
  left join app_user u on u.id = sc.created_by
  left join approval_rule r on r.tenant_id = sc.tenant_id and r.doc_type = 'stock_count'
 where sc.status = 'pending_approval'
   and sc.tenant_id = current_setting('app.tenant_id', true)::uuid

union all

select 'customer_return', cr.id, cr.entry_no, cr.entry_date,
       coalesce((select sum(return_qty * rate) from customer_return_line where return_id = cr.id), 0)::numeric(14,2),
       l.name, cr.created_by, u.full_name, cr.created_at, r.approver_role, r.min_amount,
       (current_date - cr.entry_date), cr.tenant_id
  from customer_return cr
  join ledger_account l on l.id = cr.customer_id
  left join app_user u on u.id = cr.created_by
  left join approval_rule r on r.tenant_id = cr.tenant_id and r.doc_type = 'customer_return'
 where cr.status = 'pending_approval'
   and cr.tenant_id = current_setting('app.tenant_id', true)::uuid

union all

select 'write_off', wo.id, wo.entry_no, wo.entry_date,
       coalesce((select sum(value) from write_off_line where write_off_id = wo.id), 0)::numeric(14,2),
       'Internal', wo.created_by, u.full_name, wo.created_at, r.approver_role, r.min_amount,
       (current_date - wo.entry_date), wo.tenant_id
  from write_off wo
  left join app_user u on u.id = wo.created_by
  left join approval_rule r on r.tenant_id = wo.tenant_id and r.doc_type = 'write_off'
 where wo.status = 'pending_approval'
   and wo.tenant_id = current_setting('app.tenant_id', true)::uuid;

grant select on v_pending_approvals to link_erp_app;
