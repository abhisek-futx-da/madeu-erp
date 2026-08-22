-- What the queries a mill runs all day actually cost at a year's volume.
-- Reports timing and, for the ones that matter, whether the planner reached
-- for an index or gave up and scanned.

\set ON_ERROR_STOP on
set app.tenant_id = '11111111-1111-1111-1111-111111111111';

\echo ''
\echo '################ the screens a clerk opens ################'
\timing on

\echo '-- barcode lookup (the single most-run query on the floor)'
select barcode, status, current_qty from piece where barcode = 'LOAD98765';

\echo '-- one piece''s whole history'
select count(*) from v_barcode_history where barcode = 'LOAD98765';

\echo '-- first page of the dispatch list'
select id, challan_no, challan_date from dispatch
 where status <> 'cancelled' order by challan_date desc, challan_no desc limit 50;

\echo '-- first page of invoices, the way the API asks for it'
select i.invoice_no, i.invoice_date, p.name, i.invoice_total
  from sales_invoice i join ledger_account p on p.id = i.party_id
 order by i.invoice_date desc, i.created_at desc limit 50 offset 0;

\echo '-- page 40 of invoices: the deep offset the old limit-200 hid'
select i.invoice_no from sales_invoice i
 order by i.invoice_date desc, i.created_at desc limit 50 offset 2000;

\echo '-- searching invoices by party'
select count(*) from sales_invoice i join ledger_account p on p.id = i.party_id
 where p.name ilike '%Supreme%';

\echo ''
\echo '################ the numbers an owner reads ################'

\echo '-- dashboard, all fourteen figures in one statement'
select * from report_dashboard();

\echo '-- stock valuation across every piece on hand'
select count(*) from v_stock_valuation;

\echo '-- outstanding receivables, bill by bill'
select count(*) from v_outstanding_sales;

\echo '-- trial balance'
select count(*) from v_trial_balance;

\echo '-- profit and loss for the year'
select count(*) from report_profit_loss('2026-04-01', '2027-03-31');

\echo '-- balance sheet at year end'
select count(*) from report_balance_sheet('2027-03-31');

\echo ''
\echo '################ the returns ################'

\echo '-- GSTR-1 B2B for the year'
select count(*) from v_gstr1_b2b;

\echo '-- GSTR-3B outward'
select count(*) from v_gstr3b_outward;

\echo '-- ITC-04: what is still out at a job worker'
select count(*) from v_itc04_pending;

\echo '-- the spine check: does the cache still match the log'
select count(*) from v_piece_drift;

\timing off
\echo ''
\echo '################ did the planner use the indexes? ################'
\echo ''

\echo '-- barcode lookup'
explain (analyze, buffers, costs off, timing off)
select * from piece where barcode = 'LOAD98765';

\echo ''
\echo '-- pieces by status, which every stock screen filters on'
explain (analyze, buffers, costs off, timing off)
select count(*) from piece where status = 'grey_in_stock';

\echo ''
\echo '-- a piece''s movement history'
explain (analyze, buffers, costs off, timing off)
select * from piece_movement
 where piece_id = (select id from piece where barcode = 'LOAD98765')
 order by id;

\echo ''
\echo '-- invoice list, first page'
explain (analyze, buffers, costs off, timing off)
select i.id from sales_invoice i
 order by i.invoice_date desc, i.created_at desc limit 50;

\echo ''
\echo '-- invoice lines for one invoice (the FK index added in 021)'
explain (analyze, buffers, costs off, timing off)
select * from sales_invoice_line
 where invoice_id = (select id from sales_invoice order by invoice_no limit 1);

\echo ''
\echo '-- sequential scans still happening, worst first'
select relname,
       seq_scan, seq_tup_read,
       idx_scan,
       pg_size_pretty(pg_total_relation_size(relid)) as size
  from pg_stat_user_tables
 where seq_tup_read > 100000
 order by seq_tup_read desc
 limit 10;
