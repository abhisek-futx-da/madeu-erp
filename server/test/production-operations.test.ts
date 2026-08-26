/** A production cloth ERP must cut over stock without fake purchases and move
 * physical pieces between godowns without losing their audit trail. */
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { bootstrapTenant, type BootstrapInput } from '../src/bootstrap-tenant.ts';

const BASE = process.env.API_BASE ?? 'http://127.0.0.1:4000';
const stamp = `${Date.now()}${Math.floor(Math.random()*10000)}`;
const input: BootstrapInput = {
  legalName:`Production Cloth ${stamp}`,gstin:'27CDEFG2345H1Z5',pan:'CDEFG2345H',
  stateCode:'27',fyStart:'2026-04-01',address1:'12 Textile Compound',city:'Bhiwandi',
  pincode:'421302',email:`accounts.${stamp}@production.example`,ownerName:'Production Owner',
  ownerEmail:`owner.${stamp}@production.example`,ownerPassword:'ProductionOwnerPass123'
};
let tenantId=''; let ownerId=''; let token=''; let qualityId=''; let mainId=''; let branchId='';
let transferId='';

function directDb(){return new pg.Client({host:process.env.PGHOST,port:Number(process.env.PGPORT),
  user:process.env.PGUSER??'postgres',database:process.env.TEST_DB??'linkerp_test'});}
async function api(path:string,options:{method?:string;body?:unknown}={}){
  const response=await fetch(`${BASE}/api${path}`,{method:options.method??'GET',headers:{
    'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},
    body:options.body===undefined?undefined:JSON.stringify(options.body)});
  const text=await response.text(); return {status:response.status,body:text?JSON.parse(text):null};
}

test('prepare a clean production tenant with two godowns',async()=>{
  const db=directDb();await db.connect();
  try{const result=await bootstrapTenant(db,input);tenantId=result.tenantId;ownerId=result.ownerId;}
  finally{await db.end();}
  const login=await api('/auth/login',{method:'POST',body:{email:input.ownerEmail,password:input.ownerPassword}});
  assert.equal(login.status,200,JSON.stringify(login.body));token=login.body.token;

  assert.equal((await api('/hsn-codes',{method:'POST',body:{code:'5513',description:'Woven fabric',gst_rate:5,is_service:false}})).status,201);
  assert.equal((await api('/grades',{method:'POST',body:{code:'A',name:'First quality',sort_order:1}})).status,201);
  const quality=await api('/qualities',{method:'POST',body:{code:'PC-1',name:'Production Cloth',hsn_code:'5513'}});
  assert.equal(quality.status,201,JSON.stringify(quality.body));qualityId=quality.body.id;
  const locations=await api('/locations');mainId=locations.body.find((row:{code:string})=>row.code==='MAIN').id;
  const branch=await api('/locations',{method:'POST',body:{code:'B2',name:'Second Godown',kind:'godown',
    address:'Warehouse Road',stateCode:'27',isDefault:false,isActive:true}});
  assert.equal(branch.status,201,JSON.stringify(branch.body));branchId=branch.body.id;
  assert.equal((await api('/racks',{method:'POST',body:{code:'M-A1',name:'Main A1',location:'Main',business_location_id:mainId}})).status,201);
  assert.equal((await api('/racks',{method:'POST',body:{code:'B-A1',name:'Branch A1',location:'Branch',business_location_id:branchId}})).status,201);
});

test('audited opening grey and finish pieces enter stock without a purchase voucher',async()=>{
  const opened=await api('/opening-stock',{method:'POST',body:{fyLabel:'2026-27',stockDate:'2026-04-01',
    locationId:mainId,remarks:'signed physical opening sheet',lines:[
      {barcode:`OS-G-${stamp}`,qualityId,gradeCode:'A',lotNo:'OPEN-G',stockKind:'grey',qty:100,
       weightKg:14.5,rackCode:'M-A1',greyValue:12000,jobworkValue:0,otherValue:0},
      {barcode:`OS-F-${stamp}`,qualityId,gradeCode:'A',lotNo:'OPEN-F',stockKind:'finish',qty:92,
       weightKg:13.2,rackCode:'M-A1',greyValue:12000,jobworkValue:1800,otherValue:200}
    ]}});
  assert.equal(opened.status,201,JSON.stringify(opened.body));
  assert.equal(opened.body.pieces,2);assert.equal(opened.body.stockValue,26000);

  const batches=await api('/opening-stock');
  assert.equal(batches.status,200,JSON.stringify(batches.body));
  assert.equal(batches.body.rows[0].pieces,2);assert.equal(batches.body.rows[0].stock_value,26000);
  const stock=await api(`/location-stock?locationId=${mainId}`);
  assert.equal(stock.status,200,JSON.stringify(stock.body));
  assert.equal(stock.body.reduce((n:number,row:{pieces:number})=>n+row.pieces,0),2);

  const db=directDb();await db.connect();
  try{
    const vouchers=await db.query<{n:number}>('select count(*)::int as n from voucher where tenant_id=$1',[tenantId]);
    assert.equal(vouchers.rows[0]?.n,0,'opening stock must not fabricate a purchase or journal voucher');
  }finally{await db.end();}
});

test('a barcode transfer changes godown and rack while preserving status, quantity and value',async()=>{
  const moved=await api('/location-transfers',{method:'POST',body:{transferDate:'2026-04-02',
    fromLocationId:mainId,toLocationId:branchId,remarks:'shift finish to branch',
    lines:[{barcode:`OS-F-${stamp}`,toRack:'B-A1'}]}});
  assert.equal(moved.status,201,JSON.stringify(moved.body));transferId=moved.body.id;
  assert.equal(moved.body.pieces,1);assert.equal(moved.body.quantity,92);

  const branchStock=await api(`/location-stock?locationId=${branchId}`);
  assert.equal(branchStock.status,200);assert.equal(branchStock.body[0].rack_code,'B-A1');
  assert.equal(branchStock.body[0].status,'received_finish');assert.equal(branchStock.body[0].stock_value,14000);
  const history=await api(`/pieces/${encodeURIComponent(`OS-F-${stamp}`)}/history`);
  assert.equal(history.status,200);const last=history.body.at(-1);
  assert.equal(last.event,'transfer');assert.equal(last.from_location,'Main office / godown');
  assert.equal(last.to_location,'Second Godown');
});

test('a transfer refuses a rack from the wrong destination and rolls back completely',async()=>{
  const before=await api('/location-transfers');
  const rejected=await api('/location-transfers',{method:'POST',body:{transferDate:'2026-04-02',
    fromLocationId:mainId,toLocationId:branchId,lines:[{barcode:`OS-G-${stamp}`,toRack:'M-A1'}]}});
  assert.equal(rejected.status,400);assert.match(rejected.body.error,/destination rack/i);
  const after=await api('/location-transfers');assert.equal(after.body.total,before.body.total);
  const mainStock=await api(`/location-stock?locationId=${mainId}`);
  assert.equal(mainStock.body.some((row:{rack_code:string})=>row.rack_code==='M-A1'),true);
});

test('a transfer cannot be reversed after a later stock movement used the piece',async()=>{
  const moved=await api('/location-transfers',{method:'POST',body:{transferDate:'2026-04-02',
    fromLocationId:mainId,toLocationId:branchId,remarks:'move grey for branch count',
    lines:[{barcode:`OS-G-${stamp}`,toRack:'B-A1'}]}});
  assert.equal(moved.status,201,JSON.stringify(moved.body));
  const db=directDb();await db.connect();
  try{
    const piece=await db.query<{id:string;current_qty:number;current_weight_kg:number|null}>(
      'select id,current_qty,current_weight_kg from piece where tenant_id=$1 and barcode=$2',[tenantId,`OS-G-${stamp}`]);
    await db.query(`insert into piece_movement
      (tenant_id,piece_id,event,from_status,to_status,qty_before,qty_after,weight_before_kg,
       weight_after_kg,doc_type,doc_id,created_by,from_rack,to_rack,note)
      values($1,$2,'adjust','grey_in_stock','grey_in_stock',$3,$3,$4,$4,'stock_count',
       '00000000-0000-0000-0000-000000000999',$5,'B-A1','B-A1','branch count confirmed')`,
      [tenantId,piece.rows[0]?.id,piece.rows[0]?.current_qty,piece.rows[0]?.current_weight_kg,ownerId]);
  }finally{await db.end();}
  const blocked=await api(`/location-transfers/${moved.body.id}/cancel`,{method:'POST',body:{reason:'too late'}});
  assert.equal(blocked.status,400);assert.match(blocked.body.error,/moved after this transfer/i);
});

test('cancelling the latest transfer walks the piece back through the same movement spine',async()=>{
  const cancelled=await api(`/location-transfers/${transferId}/cancel`,{method:'POST',body:{reason:'branch request entered in error'}});
  assert.equal(cancelled.status,200,JSON.stringify(cancelled.body));assert.equal(cancelled.body.cancelled,true);
  const main=await api(`/location-stock?locationId=${mainId}`);
  assert.equal(main.body.reduce((n:number,row:{pieces:number})=>n+row.pieces,0),1);
  const history=await api(`/pieces/${encodeURIComponent(`OS-F-${stamp}`)}/history`);
  assert.equal(history.body.at(-1).to_location,'Main office / godown');
});

test('opening stock locks after the first live accounting voucher',async()=>{
  const db=directDb();await db.connect();
  try{
    const ledgers=await db.query<{id:string;code:string}>(
      `select id,code from ledger_account where tenant_id=$1 and code in ('950','970') order by code`,[tenantId]);
    const retained=ledgers.rows.find(row=>row.code==='950');const cash=ledgers.rows.find(row=>row.code==='970');
    assert.ok(retained&&cash);
    await db.query('begin');
    const voucher=await db.query<{id:string}>(`insert into voucher
      (tenant_id,voucher_no,voucher_type,voucher_date,narration,is_posted,created_by)
      values($1,'PROD-LOCK','journal','2026-04-03','start live books',true,$2) returning id`,[tenantId,ownerId]);
    await db.query(`insert into voucher_line(tenant_id,voucher_id,ledger_id,debit,credit)
      values($1,$2,$3,1,0),($1,$2,$4,0,1)`,[tenantId,voucher.rows[0]?.id,cash.id,retained.id]);
    await db.query('commit');
  }finally{await db.end();}
  const locked=await api('/opening-stock',{method:'POST',body:{fyLabel:'2026-27',stockDate:'2026-04-01',
    locationId:mainId,lines:[{barcode:`TOO-LATE-${stamp}`,qualityId,gradeCode:'A',stockKind:'grey',
      qty:1,greyValue:1}]}});
  assert.equal(locked.status,400);assert.match(locked.body.error,/locked after the first posted voucher/i);
});
