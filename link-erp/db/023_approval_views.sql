-- The approval queue, and the audit of who cleared what.
-- Split from 022 because `pending_approval` cannot be referenced until the
-- ALTER TYPE that added it has committed.

/** Everything waiting on a second person, oldest first — this is the queue. */
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
   and pay.tenant_id = current_setting('app.tenant_id', true)::uuid;

/** Who cleared what, and how long it sat. */
create or replace view v_approval_history as
select e.tenant_id, e.doc_type, e.doc_id, e.action, e.amount, e.note, e.created_at,
       u.full_name as actor, u.email as actor_email,
       (select m.role from membership m
         where m.user_id = e.actor_id and m.tenant_id = e.tenant_id) as actor_role
  from approval_event e
  left join app_user u on u.id = e.actor_id
 where e.tenant_id = current_setting('app.tenant_id', true)::uuid
 order by e.created_at desc;

grant select on v_pending_approvals, v_approval_history to link_erp_app;
