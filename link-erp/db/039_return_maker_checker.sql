-- Every return changes both custody and the books.  It therefore uses the
-- same held-voucher, second-person approval as a write-off or stock variance.

alter table approval_rule drop constraint if exists approval_doc_type;
alter table approval_rule add constraint approval_doc_type check (doc_type in (
  'sales_invoice', 'purchase_invoice', 'payment', 'stock_count',
  'grey_return', 'dyeing_return', 'customer_return', 'write_off'
));

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
 where wo.status = 'pending_approval' and wo.tenant_id = current_setting('app.tenant_id', true)::uuid;

grant select on v_pending_approvals to link_erp_app;
