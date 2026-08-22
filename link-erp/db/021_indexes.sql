-- Every foreign key a query actually navigates, indexed.
--
-- A previous pass claimed this was clean; the check it used was wrong. Counted
-- properly — a key is covered only when it is the *leading* column of some
-- index — 67 were unindexed. These are the ones worth the write cost: keys
-- pointing at a master row a user filters or joins by, and tenant_id on the
-- line tables that RLS reads first.
--
-- Deliberately skipped: created_by, closed_by, filed_by and the other audit
-- columns. Nothing scans by them, users are deactivated rather than deleted,
-- and an index on each would cost a write on every insert to buy nothing.

-- ------------------------------------------------------------- party keys --

create index if not exists gpo_by_party        on grey_purchase_order (party_id);
create index if not exists gpo_by_broker       on grey_purchase_order (broker_id);
create index if not exists gpo_by_transport    on grey_purchase_order (transport_id);
create index if not exists gpo_by_ship_to      on grey_purchase_order (ship_to_id);

create index if not exists gi_by_party         on grey_inward (party_id);
create index if not exists gi_by_broker        on grey_inward (broker_id);
create index if not exists gi_by_transport     on grey_inward (transport_id);

create index if not exists di_by_process       on dyeing_issue (process_house_id);
create index if not exists di_by_weaver        on dyeing_issue (weaver_id);
create index if not exists di_by_transport     on dyeing_issue (transport_id);
create index if not exists dr_by_process       on dyeing_receipt (process_house_id);

create index if not exists disp_by_party       on dispatch (party_id);
create index if not exists disp_by_ship_to     on dispatch (ship_to_id);
create index if not exists disp_by_transport   on dispatch (transport_id);

create index if not exists fso_by_party        on finish_sales_order (party_id);
create index if not exists fso_by_broker       on finish_sales_order (broker_id);
create index if not exists fso_by_transport    on finish_sales_order (transport_id);
create index if not exists fso_by_ship_to      on finish_sales_order (ship_to_id);

create index if not exists pi_by_party_id      on purchase_invoice (party_id);
create index if not exists si_by_party_id      on sales_invoice (party_id);
create index if not exists pay_by_party_id     on payment (party_id);
create index if not exists pay_by_bank         on payment (bank_ledger_id);
create index if not exists tax_ded_by_party    on tax_deduction (party_id);

-- --------------------------------------------------------- master lookups --

create index if not exists piece_by_quality    on piece (quality_id);
create index if not exists piece_by_design     on piece (design_id);
-- piece.held_by_ledger_id is already covered by piece_by_holder, which leads
-- with tenant_id. Every query here is tenant-scoped, so that composite serves
-- the real access pattern better than a bare index on the key would.
create index if not exists design_by_quality   on design (quality_id);
create index if not exists la_by_control       on ledger_account (control_account_id);
create index if not exists la_by_broker        on ledger_account (broker_id);
create index if not exists la_by_transport     on ledger_account (transport_id);
create index if not exists bank_by_ledger      on bank_account (ledger_id);
create index if not exists ob_by_ledger        on opening_balance (ledger_id);
create index if not exists mv_by_counterparty  on piece_movement (counterparty_id);

create index if not exists fsol_by_quality     on finish_sales_order_line (quality_id);
create index if not exists fsol_by_design      on finish_sales_order_line (design_id);
create index if not exists gpol_by_design      on grey_purchase_order_line (design_id);

create index if not exists sp_by_process       on shrinkage_policy (process_house_id);
create index if not exists sp_by_quality       on shrinkage_policy (quality_id);
create index if not exists br_by_party         on brokerage_rule (party_id);
create index if not exists br_by_broker        on brokerage_rule (broker_id);
create index if not exists rc_by_party         on rate_contract (party_id);
create index if not exists rc_by_quality       on rate_contract (quality_id);

-- ----------------------------------------------- voucher back-references --

-- Cancellation walks from a document to the vouchers it posted, and back.
create index if not exists si_by_voucher       on sales_invoice (voucher_id);
create index if not exists pi_by_voucher       on purchase_invoice (voucher_id);
create index if not exists pay_by_voucher      on payment (voucher_id);
create index if not exists gstdoc_by_voucher   on gst_document (voucher_id);
create index if not exists tax_ded_by_voucher  on tax_deduction (voucher_id);

-- --------------------------------------------- tenant_id leads every policy --

create index if not exists fsol_by_tenant      on finish_sales_order_line (tenant_id);
create index if not exists gpol_by_tenant      on grey_purchase_order_line (tenant_id);
create index if not exists ladr_by_tenant      on ledger_address (tenant_id);
create index if not exists palloc_by_tenant    on payment_allocation (tenant_id);
create index if not exists palloc_by_payment   on payment_allocation (payment_id);

create index if not exists membership_by_user  on membership (user_id);
