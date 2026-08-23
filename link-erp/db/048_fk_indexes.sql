-- Foreign keys used for joins, reversals, RLS-scoped lists, and dependency
-- checks must lead an index.  The release gate is intentionally exhaustive so
-- new workflow tables cannot quietly become slow at a year's volume.

create index if not exists grey_return_line_by_tenant on grey_return_line (tenant_id);
create index if not exists grey_return_by_weaver on grey_return (weaver_id);
create index if not exists deferred_voucher_by_posted_as on deferred_voucher (posted_as);
create index if not exists dyeing_return_by_process_house on dyeing_return (process_house_id);
create index if not exists dyeing_return_line_by_tenant on dyeing_return_line (tenant_id);
create index if not exists customer_return_by_customer on customer_return (customer_id);
create index if not exists customer_return_by_invoice on customer_return (against_invoice_id);
create index if not exists customer_return_line_by_tenant on customer_return_line (tenant_id);
create index if not exists write_off_by_voucher on write_off (voucher_id);
create index if not exists write_off_line_by_piece on write_off_line (piece_id);
create index if not exists customer_return_by_voucher on customer_return (voucher_id);
create index if not exists grey_return_by_voucher on grey_return (voucher_id);
create index if not exists dyeing_return_by_voucher on dyeing_return (voucher_id);
create index if not exists access_audit_by_actor on access_audit (actor_id);
create index if not exists access_audit_by_target on access_audit (target_user_id);
create index if not exists configuration_audit_by_actor on configuration_audit (actor_id);
create index if not exists bank_reconciliation_by_completed_by on bank_reconciliation (completed_by);
create index if not exists bank_statement_line_by_matched_by on bank_statement_line (matched_by);
create index if not exists dyeing_reprocess_line_by_tenant on dyeing_reprocess_line (tenant_id);
create index if not exists dyeing_reprocess_receipt_by_voucher on dyeing_reprocess_receipt (voucher_id);
create index if not exists dyeing_reprocess_receipt_line_by_tenant on dyeing_reprocess_receipt_line (tenant_id);
