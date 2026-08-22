-- Reference data for a demo tenant, carried over from the prototype's
-- mockData.ts. Idempotent: safe to re-run.
-- Wrapped in a transaction because `set local` needs one.

begin;

insert into tenant (id, legal_name, gstin, pan, state_code, fy_start,
                    address1, city, pincode, email) values
  ('11111111-1111-1111-1111-111111111111','Neelkamal Textiles','27ANBPC3604Q1Z0','ANBPC3604Q','27','2026-04-01',
   'Gala No. 143, 2nd Floor, Mankham Market','Bhiwandi','421302','accounts@neelkamal.test')
on conflict (gstin) do nothing;

-- password for every demo user is 'changeme' (bcrypt, cost 12)
insert into app_user (id, email, full_name, password_hash) values
  ('aaaaaaaa-0000-0000-0000-000000000001','owner@neelkamal.test','Owner',
   '$2b$12$pVYUY.crMfi1qCpWJH3w0.JrJxP31zsFGFjCwQNKc9jQFFxRK7C1S'),
  ('aaaaaaaa-0000-0000-0000-000000000002','store@neelkamal.test','Store Keeper',
   '$2b$12$pVYUY.crMfi1qCpWJH3w0.JrJxP31zsFGFjCwQNKc9jQFFxRK7C1S'),
  ('aaaaaaaa-0000-0000-0000-000000000003','viewer@neelkamal.test','Viewer',
   '$2b$12$pVYUY.crMfi1qCpWJH3w0.JrJxP31zsFGFjCwQNKc9jQFFxRK7C1S')
on conflict (email) do nothing;

insert into membership (tenant_id, user_id, role) values
  ('11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000001','owner'),
  ('11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000002','store'),
  ('11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000003','viewer')
on conflict do nothing;

set local app.tenant_id = '11111111-1111-1111-1111-111111111111';

insert into control_account (id, tenant_id, code, name, sub_control, nature) values
  ('22222222-0000-0000-0000-000000000010','11111111-1111-1111-1111-111111111111','10','Creditors For Brokerage','Sundry Creditors','sundry_creditor_brokerage'),
  ('22222222-0000-0000-0000-000000000020','11111111-1111-1111-1111-111111111111','20','Creditors For Transport','Sundry Creditors','sundry_creditor_transport'),
  ('22222222-0000-0000-0000-000000000030','11111111-1111-1111-1111-111111111111','30','Creditors For Process','Sundry Creditors','sundry_creditor_process'),
  ('22222222-0000-0000-0000-000000000040','11111111-1111-1111-1111-111111111111','40','Creditors For Grey','Sundry Creditors','sundry_creditor_grey'),
  ('22222222-0000-0000-0000-000000000050','11111111-1111-1111-1111-111111111111','50','Creditors For Finish','Sundry Creditors','sundry_creditor_finish'),
  ('22222222-0000-0000-0000-000000000060','11111111-1111-1111-1111-111111111111','60','Creditors For Expenses','Sundry Creditors','sundry_creditor_expense'),
  ('22222222-0000-0000-0000-000000000070','11111111-1111-1111-1111-111111111111','70','Debtors For Finish','Sundry Debtors','sundry_debtor_finish'),
  ('22222222-0000-0000-0000-000000000080','11111111-1111-1111-1111-111111111111','80','GST A/C','Duties & Taxes','duties_and_taxes'),
  ('22222222-0000-0000-0000-000000000090','11111111-1111-1111-1111-111111111111','90','Trading Purchase','Direct Expenses','expense'),
  ('22222222-0000-0000-0000-000000000091','11111111-1111-1111-1111-111111111111','91','Trading Sales','Direct Income','income')
on conflict (tenant_id, code) do nothing;

insert into hsn_code (tenant_id, code, description, gst_rate, is_service) values
  ('11111111-1111-1111-1111-111111111111','551311','Woven fabrics of polyester staple fibres',5,false),
  ('11111111-1111-1111-1111-111111111111','540710','Woven fabrics of high tenacity yarn of nylon',5,false),
  ('11111111-1111-1111-1111-111111111111','551511','Woven fabrics of polyester viscose',5,false),
  ('11111111-1111-1111-1111-111111111111','998821','Textile dyeing and printing job work',5,true),
  ('11111111-1111-1111-1111-111111111111','996812','Courier & transport freight services',18,true)
on conflict (tenant_id, code) do nothing;

insert into grade (tenant_id, code, name, sort_order) values
  ('11111111-1111-1111-1111-111111111111','FRESH','Fresh',1),
  ('11111111-1111-1111-1111-111111111111','LUMP','Lump',2),
  ('11111111-1111-1111-1111-111111111111','SECONDS','Seconds',3),
  ('11111111-1111-1111-1111-111111111111','A','A Grade',4),
  ('11111111-1111-1111-1111-111111111111','B','B Grade',5)
on conflict (tenant_id, code) do nothing;

-- Standing posting ledgers: the voucher engine resolves these by control-account
-- nature, so exactly one expense / income / tax ledger must exist.
insert into ledger_account (id, tenant_id, code, name, control_account_id, gst_reg_type) values
  ('33333333-0000-0000-0000-000000000900','11111111-1111-1111-1111-111111111111','900','Trading Purchase A/c','22222222-0000-0000-0000-000000000090','unregistered'),
  ('33333333-0000-0000-0000-000000000901','11111111-1111-1111-1111-111111111111','901','Trading Sales A/c','22222222-0000-0000-0000-000000000091','unregistered'),
  ('33333333-0000-0000-0000-000000000902','11111111-1111-1111-1111-111111111111','902','GST Payable / Input','22222222-0000-0000-0000-000000000080','unregistered')
on conflict (tenant_id, code) do nothing;

insert into ledger_account (id, tenant_id, code, name, alias, control_account_id, gstin, pan, credit_days, gst_reg_type) values
  ('33333333-0000-0000-0000-000000000104','11111111-1111-1111-1111-111111111111','104','Pan Global Fabrics Llp','Pan Global','22222222-0000-0000-0000-000000000040','27AAACB7204N1ZM','AAACB7204N',45,'regular'),
  ('33333333-0000-0000-0000-000000000105','11111111-1111-1111-1111-111111111111','105','L.R. Textiles','LR Tex','22222222-0000-0000-0000-000000000040','27AGLPY0818R1ZF','AGLPY0818R',30,'regular'),
  ('33333333-0000-0000-0000-000000000201','11111111-1111-1111-1111-111111111111','201','Bombay Crimpers Pvt. Ltd.','Bombay Crimpers','22222222-0000-0000-0000-000000000030','27AAECB1234M1Z5','AAECB1234M',30,'regular'),
  ('33333333-0000-0000-0000-000000000202','11111111-1111-1111-1111-111111111111','202','Prayag Texprint Llp','Prayag','22222222-0000-0000-0000-000000000030','27AABFP5678N1Z9','AABFP5678N',30,'regular'),
  ('33333333-0000-0000-0000-000000000629','11111111-1111-1111-1111-111111111111','629','Kanhaiya Textiles','Kanhaiya','22222222-0000-0000-0000-000000000050','27AGLPY0818R1ZF','AGLPY0818R',45,'regular'),
  ('33333333-0000-0000-0000-000000000701','11111111-1111-1111-1111-111111111111','701','Supreme Textile And Garments','Supreme','22222222-0000-0000-0000-000000000070','33AAKCS9012P1ZT','AAKCS9012P',30,'regular'),
  ('33333333-0000-0000-0000-000000000801','11111111-1111-1111-1111-111111111111','801','Venugopal Mudaliar','Venu','22222222-0000-0000-0000-000000000010',null,null,0,'unregistered'),
  ('33333333-0000-0000-0000-000000000802','11111111-1111-1111-1111-111111111111','802','Uttam Roadways Pvt. Ltd.','Uttam','22222222-0000-0000-0000-000000000020','27AABCU3456K1Z2','AABCU3456K',0,'regular')
on conflict (tenant_id, code) do nothing;

insert into ledger_address (tenant_id, ledger_id, label, is_ship_to, is_primary, line1, city, pincode, state_code) values
  ('11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000104','Head Office',false,true,'Gala No. 143, Mankham Market','Bhiwandi','421302','27'),
  ('11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000201','Works',true,true,'Saravali Industrial Estate','Bhiwandi','421302','27'),
  ('11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000701','Godown',true,true,'Textile Market, South Gate','Madurai','625001','33'),
  ('11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000105','Works',true,true,'Plot 22, Anjur Phata','Bhiwandi','421302','27'),
  ('11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000202','Process House',true,true,'Survey 118, Kalyan Road','Bhiwandi','421302','27'),
  ('11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000629','Head Office',false,true,'Shop 14, Cloth Market','Bhiwandi','421305','27'),
  ('11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000802','Office',false,true,'Transport Nagar','Bhiwandi','421302','27')
on conflict do nothing;

insert into quality (id, tenant_id, code, name, construction, selvedge_line, width_cms, bill_by, hsn_code, division) values
  ('44444444-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','G1','Galaxy','40x40 100x80','GALAXY - 3 *** EXCLUSIVE COTTON BLENDED FINE FABRICS ***',147,'meters','551311','Shirting'),
  ('44444444-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','M1','Matrix','30x30 76x68','MATRIX *** PREMIUM SUITING ***',147,'meters','551511','Suiting'),
  ('44444444-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111111','C1','Cotlook','60x60 92x88','COTLOOK *** FINE COTTON ***',147,'meters','551311','Shirting'),
  ('44444444-0000-0000-0000-000000000004','11111111-1111-1111-1111-111111111111','S1','Super Cotton','50x50 88x78','SUPER COTTON',152,'meters','551311','Shirting')
on conflict (tenant_id, code) do nothing;

insert into design (tenant_id, quality_id, code, name) values
  ('11111111-1111-1111-1111-111111111111','44444444-0000-0000-0000-000000000001','3','3-Galaxy'),
  ('11111111-1111-1111-1111-111111111111','44444444-0000-0000-0000-000000000002','1','1-Matrix'),
  ('11111111-1111-1111-1111-111111111111','44444444-0000-0000-0000-000000000003','7','7-Cotlook'),
  ('11111111-1111-1111-1111-111111111111','44444444-0000-0000-0000-000000000004','50','50-Super Cotton')
on conflict (tenant_id, quality_id, code) do nothing;

insert into document_series (tenant_id, doc_type, fy_label, prefix, next_number) values
  ('11111111-1111-1111-1111-111111111111','grey_po','2026-27','',1840),
  ('11111111-1111-1111-1111-111111111111','grey_inward','2026-27','',300),
  ('11111111-1111-1111-1111-111111111111','dyeing_issue','2026-27','',340),
  ('11111111-1111-1111-1111-111111111111','dyeing_receipt','2026-27','DR-',100),
  ('11111111-1111-1111-1111-111111111111','dispatch','2026-27','DC-',500),
  ('11111111-1111-1111-1111-111111111111','voucher_purchase','2026-27','PV-',1),
  ('11111111-1111-1111-1111-111111111111','voucher_sales','2026-27','SV-',1),
  ('11111111-1111-1111-1111-111111111111','voucher_jobwork','2026-27','JV-',1)
on conflict (tenant_id, doc_type, fy_label) do nothing;

commit;
