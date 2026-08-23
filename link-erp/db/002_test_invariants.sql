-- Invariant tests. Every block must print PASS; ON_ERROR_STOP aborts on a real error.
\set ON_ERROR_STOP on
\pset tuples_only on

begin;

insert into tenant (id, legal_name, gstin, pan, state_code, fy_start) values
  ('eeeeeeee-1111-1111-1111-111111111111','Invariant Test Co','29TESTC1234Q1Z0','TESTC1234Q','27','2026-04-01');
set local app.tenant_id = 'eeeeeeee-1111-1111-1111-111111111111';

insert into control_account (id, tenant_id, code, name, sub_control, nature) values
  ('22222222-0000-0000-0000-000000000001','eeeeeeee-1111-1111-1111-111111111111','40','Creditors For Grey','Sundry Creditors','sundry_creditor_grey'),
  ('22222222-0000-0000-0000-000000000002','eeeeeeee-1111-1111-1111-111111111111','30','Creditors For Process','Sundry Creditors','sundry_creditor_process');

insert into ledger_account (id, tenant_id, code, name, control_account_id, gstin, pan) values
  ('33333333-0000-0000-0000-000000000001','eeeeeeee-1111-1111-1111-111111111111','104','Pan Global Fabrics Llp','22222222-0000-0000-0000-000000000001','27AAACB7204N1ZM','AAACB7204N'),
  ('33333333-0000-0000-0000-000000000002','eeeeeeee-1111-1111-1111-111111111111','201','Bombay Crimpers Pvt Ltd','22222222-0000-0000-0000-000000000002','27AGLPY0818R1ZF','AGLPY0818R');

insert into hsn_code (tenant_id, code, description, gst_rate) values
  ('eeeeeeee-1111-1111-1111-111111111111','551311','Woven fabrics of polyester staple fibres',5);
insert into grade (tenant_id, code, name) values
  ('eeeeeeee-1111-1111-1111-111111111111','LUMP','Lump');
insert into quality (id, tenant_id, code, name, hsn_code, width_cms) values
  ('eeee4444-0000-0000-0000-000000000001','eeeeeeee-1111-1111-1111-111111111111','G1','Galaxy','551311',147);
insert into piece (id, tenant_id, barcode, quality_id, grade_code, lot_no, grey_qty, current_qty) values
  ('55555555-0000-0000-0000-000000000001','eeeeeeee-1111-1111-1111-111111111111','95271100001','eeee4444-0000-0000-0000-000000000001','LUMP','1100/B',118,118);

-- 1. barcode is unique per tenant
do $$ begin
  begin
    insert into piece (tenant_id, barcode, quality_id, grade_code, grey_qty, current_qty)
      values ('eeeeeeee-1111-1111-1111-111111111111','95271100001','eeee4444-0000-0000-0000-000000000001','LUMP',10,10);
    raise exception 'FAIL 1: duplicate barcode accepted';
  exception when unique_violation then raise notice 'PASS 1  duplicate barcode rejected';
  end;
end $$;

-- 2. malformed GSTIN is rejected
do $$ begin
  begin
    insert into ledger_account (tenant_id, code, name, control_account_id, gstin)
      values ('eeeeeeee-1111-1111-1111-111111111111','999','Bad Co','22222222-0000-0000-0000-000000000001','NOTAGSTIN');
    raise exception 'FAIL 2: malformed GSTIN accepted';
  exception when check_violation then raise notice 'PASS 2  malformed GSTIN rejected';
  end;
end $$;

-- 3. a registered party with no GSTIN is rejected
do $$ begin
  begin
    insert into ledger_account (tenant_id, code, name, control_account_id, gst_reg_type)
      values ('eeeeeeee-1111-1111-1111-111111111111','998','No GSTIN Co','22222222-0000-0000-0000-000000000001','regular');
    raise exception 'FAIL 3: regular party without GSTIN accepted';
  exception when check_violation then raise notice 'PASS 3  registered party without GSTIN rejected';
  end;
end $$;

-- 4. a legal movement advances the piece
insert into piece_movement (tenant_id, piece_id, event, from_status, to_status, qty_before, qty_after, counterparty_id, doc_type, doc_id)
  values ('eeeeeeee-1111-1111-1111-111111111111','55555555-0000-0000-0000-000000000001','issue','grey_in_stock','issued_to_dyeing',118,118,'33333333-0000-0000-0000-000000000002','dyeing_issue',gen_random_uuid());
do $$ declare s piece_status; h uuid; begin
  select status, held_by_ledger_id into s, h from piece where id='55555555-0000-0000-0000-000000000001';
  if s <> 'issued_to_dyeing' or h <> '33333333-0000-0000-0000-000000000002' then
    raise exception 'FAIL 4: piece not advanced (status=%, holder=%)', s, h;
  end if;
  raise notice 'PASS 4  legal movement advanced piece to % at process house', s;
end $$;

-- 5. an illegal transition is refused
do $$ begin
  begin
    insert into piece_movement (tenant_id, piece_id, event, from_status, to_status, qty_before, qty_after, doc_type, doc_id)
      values ('eeeeeeee-1111-1111-1111-111111111111','55555555-0000-0000-0000-000000000001','dispatch','issued_to_dyeing','dispatched',118,118,'dispatch',gen_random_uuid());
    raise exception 'FAIL 5: illegal transition accepted';
  exception when raise_exception then
    if sqlerrm like 'FAIL 5%' then raise; end if;
    raise notice 'PASS 5  illegal transition issued_to_dyeing -> dispatched refused';
  end;
end $$;

-- 6. the movement log is append-only
update piece_movement set qty_after = 999 where piece_id = '55555555-0000-0000-0000-000000000001';
delete from piece_movement where piece_id = '55555555-0000-0000-0000-000000000001';
do $$ declare n int; q numeric; begin
  select count(*), max(qty_after) into n, q from piece_movement where piece_id='55555555-0000-0000-0000-000000000001';
  if n <> 1 or q <> 118 then raise exception 'FAIL 6: log mutated (n=%, qty=%)', n, q; end if;
  raise notice 'PASS 6  movement log survived UPDATE and DELETE';
end $$;

-- 7. an unbalanced voucher cannot commit
do $$ begin
  begin
    insert into voucher (id, tenant_id, voucher_no, voucher_type, voucher_date)
      values ('66666666-0000-0000-0000-000000000001','eeeeeeee-1111-1111-1111-111111111111','V1','purchase','2026-08-21');
    insert into voucher_line (tenant_id, voucher_id, ledger_id, debit)
      values ('eeeeeeee-1111-1111-1111-111111111111','66666666-0000-0000-0000-000000000001','33333333-0000-0000-0000-000000000001',5000);
    -- credit side deliberately omitted
    set constraints voucher_balanced immediate;
    raise exception 'FAIL 7: unbalanced voucher accepted';
  exception when raise_exception then
    if sqlerrm like 'FAIL 7%' then raise; end if;
    raise notice 'PASS 7  unbalanced voucher refused at commit';
  end;
end $$;

-- 8. shrinkage is computed, not stored by hand
insert into dyeing_issue (id, tenant_id, entry_no, entry_date, process_house_id, challan_no, challan_date)
  values ('77777777-0000-0000-0000-000000000001','eeeeeeee-1111-1111-1111-111111111111','DI-1','2026-08-01','33333333-0000-0000-0000-000000000002','PC-1','2026-08-01');
insert into dyeing_issue_line (id, tenant_id, issue_id, piece_id, sno, issued_qty)
  values ('88888888-0000-0000-0000-000000000001','eeeeeeee-1111-1111-1111-111111111111','77777777-0000-0000-0000-000000000001','55555555-0000-0000-0000-000000000001',1,118);
insert into dyeing_receipt (id, tenant_id, entry_no, entry_date, process_house_id, challan_no, challan_date)
  values ('99999999-0000-0000-0000-000000000001','eeeeeeee-1111-1111-1111-111111111111','DR-1','2026-08-15','33333333-0000-0000-0000-000000000002','PR-1','2026-08-15');
insert into dyeing_receipt_line (tenant_id, receipt_id, issue_line_id, piece_id, sno, issued_qty, received_qty, job_rate, finish_grade)
  values ('eeeeeeee-1111-1111-1111-111111111111','99999999-0000-0000-0000-000000000001','88888888-0000-0000-0000-000000000001','55555555-0000-0000-0000-000000000001',1,118,112.10,18,'A');
do $$ declare s numeric; p numeric; a numeric; begin
  select shrinkage_qty, shrinkage_pct, job_amount into s, p, a from dyeing_receipt_line;
  if round(s,2) <> 5.90 or round(p,2) <> 5.00 or round(a,2) <> 2017.80 then
    raise exception 'FAIL 8: shrinkage wrong (qty=%, pct=%, amt=%)', s, p, a;
  end if;
  raise notice 'PASS 8  shrinkage % mtr = %%%, jobwork = Rs %', s, round(p,2), a;
end $$;

-- 9. impossible shrinkage (more back than went out) is refused
do $$ begin
  begin
    insert into dyeing_receipt_line (tenant_id, receipt_id, issue_line_id, piece_id, sno, issued_qty, received_qty, finish_grade)
      values ('eeeeeeee-1111-1111-1111-111111111111','99999999-0000-0000-0000-000000000001','88888888-0000-0000-0000-000000000001','55555555-0000-0000-0000-000000000001',2,118,200,'A');
    raise exception 'FAIL 9: impossible receipt accepted';
  exception when check_violation or unique_violation then raise notice 'PASS 9  receipt exceeding issued qty refused';
  end;
end $$;

-- 11. goods lying at a process house cannot be cut up
do $$ begin
  begin
    insert into piece_movement (tenant_id, piece_id, event, from_status, to_status, qty_before, qty_after, doc_type, doc_id)
      values ('eeeeeeee-1111-1111-1111-111111111111','55555555-0000-0000-0000-000000000001','split','issued_to_dyeing','consumed',118,0,'piece_regroup',gen_random_uuid());
    raise exception 'FAIL 11: a piece out at dyeing was split';
  exception when raise_exception then
    if sqlerrm like 'FAIL 11%' then raise; end if;
    raise notice 'PASS 11 splitting goods held by a process house refused';
  end;
end $$;

-- 12. the lineage log is append-only, like the movement log
insert into piece (id, tenant_id, barcode, quality_id, grade_code, lot_no, grey_qty, current_qty) values
  ('55555555-0000-0000-0000-000000000002','eeeeeeee-1111-1111-1111-111111111111','95271100001-1','eeee4444-0000-0000-0000-000000000001','LUMP','1100/B',60,60);
insert into piece_regroup (id, tenant_id, entry_no, entry_date, kind) values
  ('bbbbbbbb-0000-0000-0000-000000000001','eeeeeeee-1111-1111-1111-111111111111','RG-1','2026-08-20','split');
insert into piece_lineage (tenant_id, regroup_id, parent_id, child_id, qty, grey_cost) values
  ('eeeeeeee-1111-1111-1111-111111111111','bbbbbbbb-0000-0000-0000-000000000001','55555555-0000-0000-0000-000000000001','55555555-0000-0000-0000-000000000002',60,1830);
update piece_lineage set qty = 999;
delete from piece_lineage;
do $$ declare n int; q numeric; c numeric; begin
  select count(*), max(qty), max(cost) into n, q, c from piece_lineage;
  if n <> 1 or q <> 60 or c <> 1830 then raise exception 'FAIL 12: lineage mutated (n=%, qty=%, cost=%)', n, q, c; end if;
  raise notice 'PASS 12 lineage survived UPDATE and DELETE, cost still Rs %', c;
end $$;

-- 13. a submitted count sheet can no longer have its scans changed
insert into stock_count (id, tenant_id, count_no, count_date, status) values
  ('cccccccc-0000-0000-0000-000000000001','eeeeeeee-1111-1111-1111-111111111111','SC-1','2026-08-20','draft');
insert into stock_count_scan (tenant_id, count_id, barcode, qty) values
  ('eeeeeeee-1111-1111-1111-111111111111','cccccccc-0000-0000-0000-000000000001','95271100001',110);
delete from stock_count_scan where count_id = 'cccccccc-0000-0000-0000-000000000001';
do $$ declare n int; begin
  select count(*) into n from stock_count_scan;
  if n <> 0 then raise exception 'FAIL 13a: an open sheet refused a correction'; end if;
end $$;
insert into stock_count_scan (tenant_id, count_id, barcode, qty) values
  ('eeeeeeee-1111-1111-1111-111111111111','cccccccc-0000-0000-0000-000000000001','95271100001',110);
update stock_count set status = 'pending_approval' where id = 'cccccccc-0000-0000-0000-000000000001';
do $$ begin
  begin
    delete from stock_count_scan where count_id = 'cccccccc-0000-0000-0000-000000000001';
    raise exception 'FAIL 13: a submitted sheet let a scan be deleted';
  exception when raise_exception then
    if sqlerrm like 'FAIL 13%' then raise; end if;
    raise notice 'PASS 13 a submitted count sheet froze its scans';
  end;
end $$;

-- 14. an approved variance is evidence, not a draft
insert into stock_count_variance (tenant_id, count_id, barcode, kind, outcome, system_qty, counted_qty, value, reason) values
  ('eeeeeeee-1111-1111-1111-111111111111','cccccccc-0000-0000-0000-000000000001','95271100001','short','adjust_qty',118,110,-244,'measured short at the rack');
update stock_count_variance set value = 0, reason = 'nothing to see';
delete from stock_count_variance;
do $$ declare n int; v numeric; r text; begin
  select count(*), max(value), max(reason) into n, v, r from stock_count_variance;
  if n <> 1 or v <> -244 or r <> 'measured short at the rack' then
    raise exception 'FAIL 14: variance mutated (n=%, value=%, reason=%)', n, v, r;
  end if;
  raise notice 'PASS 14 variance survived UPDATE and DELETE, still Rs %', v;
end $$;

-- 15. a kilogram-priced inward values the actual net weight, not its metres
insert into grey_inward (id, tenant_id, entry_no, entry_date, party_id, challan_no, challan_date, status) values
  ('15151515-0000-0000-0000-000000000001','eeeeeeee-1111-1111-1111-111111111111','GIN-KG-1','2026-08-21',
   '33333333-0000-0000-0000-000000000001','KG-1','2026-08-21','approved');
insert into piece (id, tenant_id, barcode, quality_id, grade_code, lot_no, grey_qty, current_qty) values
  ('15151515-0000-0000-0000-000000000002','eeeeeeee-1111-1111-1111-111111111111','KGVALUED001',
   'eeee4444-0000-0000-0000-000000000001','LUMP','KG-LOT',100,100);
insert into grey_inward_line
  (tenant_id,inward_id,piece_id,sno,received_qty,checked_qty,rate,rate_uom,gross_weight_kg,tare_weight_kg,net_weight_kg)
values
  ('eeeeeeee-1111-1111-1111-111111111111','15151515-0000-0000-0000-000000000001',
   '15151515-0000-0000-0000-000000000002',1,100,100,30,'KGS',15.5,0.5,15);
do $$ declare a numeric; begin
  select amount into a from grey_inward_line where piece_id='15151515-0000-0000-0000-000000000002';
  if a <> 450 then raise exception 'FAIL 15: kg valuation used the wrong base (%)', a; end if;
  raise notice 'PASS 15 kilogram rate valued 15 kg at Rs 450, independent of metres';
end $$;

-- 16. a kilogram rate cannot silently fall back to a missing weight
insert into piece (id, tenant_id, barcode, quality_id, grade_code, lot_no, grey_qty, current_qty) values
  ('16161616-0000-0000-0000-000000000001','eeeeeeee-1111-1111-1111-111111111111','KGMISSING001',
   'eeee4444-0000-0000-0000-000000000001','LUMP','KG-LOT',100,100);
do $$ begin
  begin
    insert into grey_inward_line
      (tenant_id,inward_id,piece_id,sno,received_qty,checked_qty,rate,rate_uom)
    values
      ('eeeeeeee-1111-1111-1111-111111111111','15151515-0000-0000-0000-000000000001',
       '16161616-0000-0000-0000-000000000001',2,100,100,30,'KGS');
    raise exception 'FAIL 16: kg-priced inward without a weight was accepted';
  exception when check_violation then
    raise notice 'PASS 16 kilogram rate without positive net weight refused';
  end;
end $$;

-- 17. the movement spine advances the weight cache with the metre cache
insert into piece_movement
  (tenant_id,piece_id,event,from_status,to_status,qty_before,qty_after,
   weight_before_kg,weight_after_kg,counterparty_id,doc_type,doc_id)
values
  ('eeeeeeee-1111-1111-1111-111111111111','15151515-0000-0000-0000-000000000002',
   'issue','grey_in_stock','issued_to_dyeing',100,100,15,15,
   '33333333-0000-0000-0000-000000000002','dyeing_issue',gen_random_uuid());
do $$ declare w numeric; begin
  select current_weight_kg into w from piece where id='15151515-0000-0000-0000-000000000002';
  if w <> 15 then raise exception 'FAIL 17: piece weight cache is %', w; end if;
  raise notice 'PASS 17 movement spine advanced the parallel kilogram cache';
end $$;

-- 18. consolidated process bills cannot allocate more than actually returned
insert into process_house_bill
  (id,tenant_id,process_house_id,supplier_bill_no,bill_date,billed_metres,billed_amount)
values
  ('18181818-0000-0000-0000-000000000001','eeeeeeee-1111-1111-1111-111111111111',
   '33333333-0000-0000-0000-000000000002','PH-1','2026-08-21',100,1800),
  ('18181818-0000-0000-0000-000000000002','eeeeeeee-1111-1111-1111-111111111111',
   '33333333-0000-0000-0000-000000000002','PH-2','2026-08-21',13,234);
insert into process_house_bill_allocation
  (tenant_id,bill_id,receipt_line_id,allocated_metres,allocated_amount)
select 'eeeeeeee-1111-1111-1111-111111111111','18181818-0000-0000-0000-000000000001',id,100,1800
from dyeing_receipt_line where receipt_id='99999999-0000-0000-0000-000000000001';
do $$ begin
  begin
    insert into process_house_bill_allocation
      (tenant_id,bill_id,receipt_line_id,allocated_metres,allocated_amount)
    select 'eeeeeeee-1111-1111-1111-111111111111','18181818-0000-0000-0000-000000000002',id,13,234
    from dyeing_receipt_line where receipt_id='99999999-0000-0000-0000-000000000001';
    raise exception 'FAIL 18: process bill over-allocated a receipt';
  exception when raise_exception then
    if sqlerrm like 'FAIL 18%' then raise; end if;
    raise notice 'PASS 18 process-house billing cannot exceed the actual receipt';
  end;
end $$;

-- 19. a staged migration row is immutable evidence
insert into data_import
  (id,tenant_id,resource,filename,total_rows,valid_rows,error_rows,created_by)
select '19191919-0000-0000-0000-000000000001','eeeeeeee-1111-1111-1111-111111111111',
       'grades','grades.csv',1,1,0,id
  from app_user order by created_at limit 1;
insert into data_import_row
  (tenant_id,import_id,row_no,raw_data,normalized_data,action)
values
  ('eeeeeeee-1111-1111-1111-111111111111','19191919-0000-0000-0000-000000000001',2,
   '{"code":"A","name":"First"}','{"code":"A","name":"First","sort_order":1}','insert');
do $$ begin
  begin
    update data_import_row set normalized_data='{"code":"B"}' where import_id='19191919-0000-0000-0000-000000000001';
    raise exception 'FAIL 19: an import preview row was rewritten';
  exception when raise_exception then
    if sqlerrm like 'FAIL 19%' then raise; end if;
    raise notice 'PASS 19 import preview rows are append-only evidence';
  end;
end $$;

-- 20. an import containing rejected rows cannot be marked applied
do $$ declare uid uuid; begin
  select id into uid from app_user order by created_at limit 1;
  begin
    insert into data_import
      (tenant_id,resource,filename,status,total_rows,valid_rows,error_rows,created_by,applied_at)
    values
      ('eeeeeeee-1111-1111-1111-111111111111','grades','bad.csv','applied',1,0,1,uid,now());
    raise exception 'FAIL 20: a rejected batch was marked applied';
  exception when check_violation then
    raise notice 'PASS 20 rejected rows prevent an applied import';
  end;
end $$;

-- 10. tenant isolation actually filters
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'tenant_app') then
    create role tenant_app nologin;
  end if;
end $$;
grant select on all tables in schema public to tenant_app;
set local role tenant_app;
set local app.tenant_id = '00000000-0000-0000-0000-000000000000';
do $$ declare n int; begin
  select count(*) into n from piece;
  if n <> 0 then raise exception 'FAIL 10: RLS leaked % rows to a foreign tenant', n; end if;
  raise notice 'PASS 10 RLS hid all pieces from a foreign tenant';
end $$;
reset role;

rollback;
