-- A stock count that nobody can see in the approval queue is a control that
-- quietly does not happen. Appended as a fourth branch; the counted stock
-- stands where a party name does on the other three, because "Rack A1, Galaxy"
-- is what an owner needs to recognise the sheet.

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

select 'stock_count', c.id, c.count_no, c.count_date, c.net_value,
       concat_ws(' · ', nullif('Rack ' || c.rack_code, 'Rack '), q.name,
                 nullif('Lot ' || c.lot_no, 'Lot ')),
       c.created_by, u.full_name, c.created_at, r.approver_role, r.min_amount,
       (current_date - c.count_date), c.tenant_id
  from stock_count c
  left join quality q on q.id = c.quality_id
  left join app_user u on u.id = c.created_by
  left join approval_rule r on r.tenant_id = c.tenant_id and r.doc_type = 'stock_count'
 where c.status = 'pending_approval'
   and c.tenant_id = current_setting('app.tenant_id', true)::uuid;

grant select on v_pending_approvals to link_erp_app;
