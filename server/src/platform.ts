import { createHash, randomBytes } from 'node:crypto';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { many, one, withTenant, withoutTenant, type Db } from './db.ts';
import { requireWrite, type Permission } from './auth.ts';

const uuid=z.string().uuid();
const entityType=z.enum(['ledger_account','piece','grey_purchase_order','finish_sales_order','sales_invoice','purchase_invoice','payment','location_transfer','edition_document','edition_resource']);
const fieldType=z.enum(['text','number','date','boolean','choice','multi_choice']);
const eventType=z.string().regex(/^[a-z][a-z0-9_.]{2,79}$/);

const ENTITIES:Record<z.infer<typeof entityType>,{table:string;area:string}>={
  ledger_account:{table:'ledger_account',area:'masters'},piece:{table:'piece',area:'store'},
  grey_purchase_order:{table:'grey_purchase_order',area:'purchase'},finish_sales_order:{table:'finish_sales_order',area:'sales'},
  sales_invoice:{table:'sales_invoice',area:'accounts'},purchase_invoice:{table:'purchase_invoice',area:'accounts'},
  payment:{table:'payment',area:'accounts'},location_transfer:{table:'location_transfer',area:'store'},
  edition_document:{table:'edition_document',area:'store'},edition_resource:{table:'edition_resource',area:'store'}
};

type SourceColumn={label:string;type:'text'|'number'|'date';sql:string};
type ReportSource={label:string;from:string;columns:Record<string,SourceColumn>};
export const PLATFORM_REPORT_SOURCES:Record<string,ReportSource>={
  receivables:{label:'Outstanding receivables',from:'v_outstanding_sales r',columns:{
    invoice_no:{label:'Invoice',type:'text',sql:'r.invoice_no'},invoice_date:{label:'Date',type:'date',sql:'r.invoice_date'},
    code:{label:'Party code',type:'text',sql:'r.code'},party:{label:'Party',type:'text',sql:'r.party'},
    invoice_total:{label:'Invoice total',type:'number',sql:'r.invoice_total'},paid:{label:'Paid',type:'number',sql:'r.paid'},
    outstanding:{label:'Outstanding',type:'number',sql:'r.outstanding'},overdue_days:{label:'Overdue days',type:'number',sql:'r.overdue_days'}
  }},
  payables:{label:'Outstanding payables',from:'v_outstanding_purchases r',columns:{
    our_ref:{label:'Our reference',type:'text',sql:'r.our_ref'},supplier_invoice_no:{label:'Supplier invoice',type:'text',sql:'r.supplier_invoice_no'},
    invoice_date:{label:'Date',type:'date',sql:'r.invoice_date'},code:{label:'Party code',type:'text',sql:'r.code'},party:{label:'Party',type:'text',sql:'r.party'},
    invoice_total:{label:'Invoice total',type:'number',sql:'r.invoice_total'},paid:{label:'Paid',type:'number',sql:'r.paid'},outstanding:{label:'Outstanding',type:'number',sql:'r.outstanding'}
  }},
  stock:{label:'Stock summary',from:'v_stock_summary r',columns:{
    status:{label:'Stage',type:'text',sql:'r.status'},quality:{label:'Quality',type:'text',sql:'r.quality'},grade:{label:'Grade',type:'text',sql:'r.grade'},
    pcs:{label:'Pieces',type:'number',sql:'r.pcs'},qty:{label:'Metres',type:'number',sql:'r.qty'}
  }},
  cash_book:{label:'Cash book',from:'v_cash_book r',columns:{
    payment_date:{label:'Date',type:'date',sql:'r.payment_date'},voucher_no:{label:'Voucher',type:'text',sql:'r.voucher_no'},kind:{label:'Type',type:'text',sql:'r.kind'},
    mode:{label:'Mode',type:'text',sql:'r.mode'},party:{label:'Party',type:'text',sql:'r.party'},bank_or_cash:{label:'Bank / cash',type:'text',sql:'r.bank_or_cash'},
    inflow:{label:'Inflow',type:'number',sql:'r.inflow'},outflow:{label:'Outflow',type:'number',sql:'r.outflow'},instrument_no:{label:'Reference',type:'text',sql:'r.instrument_no'}
  }},
  trial_balance:{label:'Trial balance',from:'v_trial_balance r',columns:{
    code:{label:'Ledger code',type:'text',sql:'r.code'},name:{label:'Ledger',type:'text',sql:'r.name'},control_account:{label:'Control account',type:'text',sql:'r.control_account'},
    total_debit:{label:'Debit',type:'number',sql:'r.total_debit'},total_credit:{label:'Credit',type:'number',sql:'r.total_credit'},balance:{label:'Balance',type:'number',sql:'r.balance'}
  }},
  party_balances:{label:'Party balances',from:'v_party_balance r',columns:{
    code:{label:'Party code',type:'text',sql:'r.code'},name:{label:'Party',type:'text',sql:'r.name'},balance:{label:'Balance',type:'number',sql:'r.balance'}
  }},
  edition_operations:{label:'Edition operations',from:'edition_document r',columns:{
    edition:{label:'Edition',type:'text',sql:'r.edition'},doc_type:{label:'Workflow',type:'text',sql:'r.doc_type'},
    doc_no:{label:'Document',type:'text',sql:'r.doc_no'},doc_date:{label:'Date',type:'date',sql:'r.doc_date'},
    status:{label:'Status',type:'text',sql:'r.status'},remarks:{label:'Remarks',type:'text',sql:'r.remarks'}
  }},
  edition_stock:{label:'Edition material stock',from:'v_edition_stock r',columns:{
    edition:{label:'Edition',type:'text',sql:'r.edition'},resource_type:{label:'Resource type',type:'text',sql:'r.resource_type'},
    code:{label:'Code',type:'text',sql:'r.code'},name:{label:'Resource',type:'text',sql:'r.name'},uom:{label:'UOM',type:'text',sql:'r.uom'},
    quantity:{label:'Quantity',type:'number',sql:'r.quantity'},value:{label:'Value',type:'number',sql:'r.value_paise/100.0'},average_rate:{label:'Average rate',type:'number',sql:'r.average_rate_paise/100.0'}
  }},
  edition_job_cost:{label:'Edition job costing',from:'v_edition_job_cost r',columns:{
    edition:{label:'Edition',type:'text',sql:'r.edition'},doc_type:{label:'Workflow',type:'text',sql:'r.doc_type'},doc_no:{label:'Document',type:'text',sql:'r.doc_no'},
    doc_date:{label:'Date',type:'date',sql:'r.doc_date'},status:{label:'Status',type:'text',sql:'r.status'},material:{label:'Material cost',type:'number',sql:'r.material_paise/100.0'},
    labour:{label:'Labour cost',type:'number',sql:'r.labour_paise/100.0'},machine:{label:'Machine cost',type:'number',sql:'r.machine_paise/100.0'},
    logistics_duty:{label:'Freight / duty',type:'number',sql:'r.logistics_duty_paise/100.0'},other:{label:'Other cost',type:'number',sql:'r.other_paise/100.0'},total:{label:'Total cost',type:'number',sql:'r.total_cost_paise/100.0'}
  }}
};

const filterSchema=z.object({column:z.string().min(1).max(60),operator:z.enum(['eq','contains','gte','lte']),value:z.union([z.string(),z.number()])});
const reportInput=z.object({id:uuid.optional(),name:z.string().trim().min(2).max(100),description:z.string().trim().max(500).default(''),sourceKey:z.string().min(2).max(60),columns:z.array(z.string()).min(1).max(30),filters:z.array(filterSchema).max(12).default([]),sort:z.object({column:z.string(),direction:z.enum(['asc','desc'])}).optional(),isShared:z.boolean().default(false),isActive:z.boolean().default(true)});

function canWrite(req:Request,area:string){return req.session?.permissions?.includes(`write:${area}` as Permission)??false;}
function validateReport(body:z.infer<typeof reportInput>){
  const source=PLATFORM_REPORT_SOURCES[body.sourceKey];if(!source)throw new Error('unknown report data source');
  if(new Set(body.columns).size!==body.columns.length||body.columns.some(key=>!source.columns[key]))throw new Error('report contains an unknown or duplicate column');
  for(const filter of body.filters){const col=source.columns[filter.column];if(!col)throw new Error(`unknown filter column ${filter.column}`);if(filter.operator==='contains'&&col.type!=='text')throw new Error('contains is available only for text columns');}
  if(body.sort&&!source.columns[body.sort.column])throw new Error('unknown report sort column');
  return source;
}
function reportSql(source:ReportSource,definition:any,limit:number){
  const params:unknown[]=[];const clauses:string[]=[];
  for(const filter of definition.filters as z.infer<typeof filterSchema>[]){const col=source.columns[filter.column]!;params.push(filter.value);const p=`$${params.length}`;
    if(filter.operator==='contains')clauses.push(`${col.sql} ilike '%'||${p}::text||'%'`);
    else {const op={eq:'=',gte:'>=',lte:'<='}[filter.operator];const cast=col.type==='number'?'numeric':col.type==='date'?'date':'text';clauses.push(`${col.sql} ${op} ${p}::${cast}`);}}
  params.push(limit);const select=definition.columns.map((key:string)=>`${source.columns[key]!.sql} as "${key}"`).join(',');
  const sort=definition.sort?.column?`${source.columns[definition.sort.column]!.sql} ${definition.sort.direction==='desc'?'desc':'asc'}`:source.columns[definition.columns[0]]!.sql;
  return{sql:`select ${select} from ${source.from}${clauses.length?` where ${clauses.join(' and ')}`:''} order by ${sort} limit $${params.length}`,params};
}
const tokenHash=(token:string)=>createHash('sha256').update(token).digest('hex');
const newToken=()=>`lerp_${randomBytes(32).toString('base64url')}`;

async function feedIdentity(req:Request){
  const token=req.get('x-erp-integration-key')?.trim();if(!token)return null;
  return withoutTenant(db=>one<{tenant_id:string;connection_id:string}>(db,'select * from authenticate_integration_feed($1)',[tokenHash(token)]));
}

/** Public, token-scoped pull feed. It is mounted before browser/session auth. */
export function publicPlatformRouter(){const router=Router();
  router.get('/integrations/feed',async(req,res,next)=>{try{const identity=await feedIdentity(req);if(!identity)return res.status(401).json({error:'invalid integration key'});
    const after=z.coerce.number().int().min(0).default(0).parse(req.query.after);const limit=z.coerce.number().int().min(1).max(500).default(100).parse(req.query.limit);
    const rows=await withTenant(identity.tenant_id,null,db=>many(db,`select d.id,e.event_key,e.event_type,e.entity_id,e.payload,e.occurred_at,d.attempts from integration_delivery d join integration_event e on e.id=d.event_id where d.connection_id=$1 and d.status in ('pending','failed') and d.id>$2 order by d.id limit $3`,[identity.connection_id,after,limit]));
    res.json({rows,nextAfter:(rows.at(-1) as any)?.id??after});}catch(error){next(error);}});
  router.post('/integrations/feed/:id/ack',async(req,res,next)=>{try{const identity=await feedIdentity(req);if(!identity)return res.status(401).json({error:'invalid integration key'});const id=z.coerce.number().int().positive().parse(req.params.id);const body=z.object({status:z.enum(['delivered','failed']),error:z.string().max(1000).optional()}).parse(req.body);
    const row=await withTenant(identity.tenant_id,null,db=>one(db,`update integration_delivery set status=$3,attempts=attempts+1,last_error=$4,delivered_at=case when $3='delivered' then now() else null end,updated_at=now() where id=$1 and connection_id=$2 and status in ('pending','failed') returning id,status,attempts`,[id,identity.connection_id,body.status,body.error??null]));
    if(!row)return res.status(404).json({error:'delivery not found or already acknowledged'});res.json(row);}catch(error){next(error);}});
  return router;
}

export function platformRouter(){const router=Router();
  router.get('/platform/entities',(_req,res)=>res.json(Object.keys(ENTITIES)));
  router.get('/platform/custom-fields',async(req,res,next)=>{try{const type=entityType.optional().parse(req.query.entityType);const{tenantId,userId}=req.session!;res.json(await withTenant(tenantId,userId,db=>many(db,`select id,entity_type,field_key,label,data_type,help_text,required,choices,sort_order,is_active,updated_at from custom_field_definition where ($1::text is null or entity_type=$1) order by entity_type,sort_order,label`,[type??null])));}catch(e){next(e);}});
  router.post('/platform/custom-fields',requireWrite('owner'),async(req,res,next)=>{try{const body=z.object({id:uuid.optional(),entityType,label:z.string().trim().min(2).max(80),fieldKey:z.string().regex(/^[a-z][a-z0-9_]{1,39}$/),dataType:fieldType,helpText:z.string().max(300).default(''),required:z.boolean().default(false),choices:z.array(z.string().trim().min(1).max(80)).max(50).default([]),sortOrder:z.coerce.number().int().min(-1000).max(1000).default(0),isActive:z.boolean().default(true)}).parse(req.body);
    if(['choice','multi_choice'].includes(body.dataType)&&body.choices.length<1)throw new Error('choice fields need at least one allowed value');const{tenantId,userId}=req.session!;
    const row=await withTenant(tenantId,userId,async db=>{const before=body.id?await one(db,'select to_jsonb(d) as data from custom_field_definition d where id=$1',[body.id]):null;const saved=body.id?await one(db,`update custom_field_definition set entity_type=$2,field_key=$3,label=$4,data_type=$5,help_text=$6,required=$7,choices=$8,sort_order=$9,is_active=$10,updated_at=now() where id=$1 returning *`,[body.id,body.entityType,body.fieldKey,body.label,body.dataType,body.helpText,body.required,JSON.stringify(body.choices),body.sortOrder,body.isActive]):await one(db,`insert into custom_field_definition(tenant_id,entity_type,field_key,label,data_type,help_text,required,choices,sort_order,is_active,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,[tenantId,body.entityType,body.fieldKey,body.label,body.dataType,body.helpText,body.required,JSON.stringify(body.choices),body.sortOrder,body.isActive,userId]);if(!saved)throw new Error('custom field not found');await db.query(`insert into platform_change_event(tenant_id,area,target_id,action,before_data,after_data,actor_id) values($1,'custom_field',$2,$3,$4,to_jsonb($5::jsonb),$6)`,[tenantId,(saved as any).id,body.id?'updated':'created',(before as any)?.data??null,JSON.stringify(saved),userId]);return saved;});res.status(body.id?200:201).json(row);}catch(e){next(e);}});
  router.get('/platform/custom-values',async(req,res,next)=>{try{const type=entityType.parse(req.query.entityType);const entityId=uuid.parse(req.query.entityId);const{tenantId,userId}=req.session!;const rows=await withTenant(tenantId,userId,async db=>{if(!await one(db,`select id from ${ENTITIES[type].table} where id=$1`,[entityId]))throw new Error('record not found');return many(db,`select d.id,d.field_key,d.label,d.data_type,d.help_text,d.required,d.choices,v.value,v.updated_at from custom_field_definition d left join custom_field_value v on v.definition_id=d.id and v.entity_id=$2 where d.entity_type=$1 and d.is_active order by d.sort_order,d.label`,[type,entityId]);});res.json(rows);}catch(e){next(e);}});
  router.post('/platform/custom-values',async(req,res,next)=>{try{const body=z.object({entityType,entityId:uuid,values:z.array(z.object({definitionId:uuid,value:z.unknown()})).max(100)}).parse(req.body);const area=ENTITIES[body.entityType].area;const editionEntity=['edition_document','edition_resource'].includes(body.entityType);const allowed=editionEntity?(canWrite(req,'store')||canWrite(req,'sales')):canWrite(req,area);if(!allowed)return res.status(403).json({error:`role ${req.session?.role} cannot write ${area}`});const{tenantId,userId}=req.session!;await withTenant(tenantId,userId,async db=>{if(!await one(db,`select id from ${ENTITIES[body.entityType].table} where id=$1`,[body.entityId]))throw new Error('record not found');for(const item of body.values){const result=await db.query(`insert into custom_field_value(tenant_id,definition_id,entity_id,value,updated_by) select $1,d.id,$2,$3::jsonb,$4 from custom_field_definition d where d.id=$5 and d.entity_type=$6 and d.is_active on conflict(tenant_id,definition_id,entity_id) do update set value=excluded.value,updated_by=excluded.updated_by,updated_at=now()`,[tenantId,body.entityId,JSON.stringify(item.value),userId,item.definitionId,body.entityType]);if(result.rowCount!==1)throw new Error('custom field does not belong to this record type');}});res.json({saved:body.values.length});}catch(e){next(e);}});

  router.get('/platform/report-sources',(_req,res)=>res.json(Object.entries(PLATFORM_REPORT_SOURCES).map(([key,s])=>({key,label:s.label,columns:Object.entries(s.columns).map(([column,c])=>({key:column,label:c.label,type:c.type}))}))));
  router.get('/platform/reports',async(req,res,next)=>{try{const{tenantId,userId}=req.session!;res.json(await withTenant(tenantId,userId,db=>many(db,`select id,name,description,source_key,columns,filters,sort_spec,is_shared,is_active,created_by,updated_at from custom_report_definition where is_active and (is_shared or created_by=$1) order by name`,[userId])));}catch(e){next(e);}});
  router.post('/platform/reports',async(req,res,next)=>{try{const body=reportInput.parse(req.body);validateReport(body);if(body.isShared&&!canWrite(req,'owner'))return res.status(403).json({error:'only an owner can publish a shared report'});const{tenantId,userId}=req.session!;const row=await withTenant(tenantId,userId,async db=>{if(body.id){const current=await one<any>(db,'select * from custom_report_definition where id=$1',[body.id]);if(!current)throw new Error('report not found');if(current.created_by!==userId&&!canWrite(req,'owner'))throw new Error('only its creator or an owner can edit this report');const saved=await one(db,`update custom_report_definition set name=$2,description=$3,source_key=$4,columns=$5,filters=$6,sort_spec=$7,is_shared=$8,is_active=$9,updated_at=now() where id=$1 returning *`,[body.id,body.name,body.description,body.sourceKey,JSON.stringify(body.columns),JSON.stringify(body.filters),JSON.stringify(body.sort??{}),body.isShared,body.isActive]);await db.query(`insert into platform_change_event(tenant_id,area,target_id,action,before_data,after_data,actor_id) values($1,'custom_report',$2,'updated',$3,$4,$5)`,[tenantId,body.id,current,JSON.stringify(saved),userId]);return saved;}const saved=await one<any>(db,`insert into custom_report_definition(tenant_id,name,description,source_key,columns,filters,sort_spec,is_shared,is_active,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,[tenantId,body.name,body.description,body.sourceKey,JSON.stringify(body.columns),JSON.stringify(body.filters),JSON.stringify(body.sort??{}),body.isShared,body.isActive,userId]);await db.query(`insert into platform_change_event(tenant_id,area,target_id,action,after_data,actor_id) values($1,'custom_report',$2,'created',$3,$4)`,[tenantId,saved!.id,JSON.stringify(saved),userId]);return saved;});res.status(body.id?200:201).json(row);}catch(e){next(e);}});
  router.post('/platform/reports/:id/run',async(req,res,next)=>{try{const id=uuid.parse(req.params.id);const limit=z.coerce.number().int().min(1).max(5000).default(500).parse(req.body?.limit);const{tenantId,userId}=req.session!;const rows=await withTenant(tenantId,userId,async db=>{const def=await one<any>(db,'select * from custom_report_definition where id=$1 and is_active and (is_shared or created_by=$2)',[id,userId]);if(!def)throw new Error('report not found');const normalized={sourceKey:def.source_key,columns:def.columns,filters:def.filters,sort:Object.keys(def.sort_spec).length?def.sort_spec:undefined};const source=validateReport(reportInput.parse({name:def.name,description:def.description,isShared:def.is_shared,isActive:true,...normalized}));const query=reportSql(source,normalized,limit);return many(db,query.sql,query.params);});res.json({rows,limit});}catch(e){next(e);}});

  router.get('/platform/integrations',requireWrite('owner'),async(req,res,next)=>{try{const{tenantId,userId}=req.session!;res.json(await withTenant(tenantId,userId,db=>many(db,`select c.id,c.name,c.adapter,c.description,c.token_prefix,c.is_active,c.updated_at,coalesce(array_agg(s.event_type order by s.event_type) filter(where s.is_active),'{}') as subscriptions,count(d.id) filter(where d.status in ('pending','failed'))::int as pending from integration_connection c left join integration_subscription s on s.connection_id=c.id left join integration_delivery d on d.connection_id=c.id group by c.id order by c.name`)));}catch(e){next(e);}});
  router.post('/platform/integrations',requireWrite('owner'),async(req,res,next)=>{try{const body=z.object({name:z.string().trim().min(2).max(100),adapter:z.enum(['pull_api','tally','file_exchange','custom']).default('pull_api'),description:z.string().max(500).default(''),subscriptions:z.array(eventType).max(50).default([])}).parse(req.body);const token=newToken();const{tenantId,userId}=req.session!;const row=await withTenant(tenantId,userId,async db=>{const saved=await one<any>(db,`insert into integration_connection(tenant_id,name,adapter,description,token_hash,token_prefix,created_by) values($1,$2,$3,$4,$5,$6,$7) returning id,name,adapter,description,token_prefix,is_active`,[tenantId,body.name,body.adapter,body.description,tokenHash(token),token.slice(0,12),userId]);if(!saved)throw new Error('connection was not created');if(body.subscriptions.length)await db.query(`insert into integration_subscription(tenant_id,connection_id,event_type) select $1,$2,x from unnest($3::text[]) x`,[tenantId,saved.id,Array.from(new Set(body.subscriptions))]);await db.query(`insert into platform_change_event(tenant_id,area,target_id,action,after_data,actor_id) values($1,'integration',$2,'created',$3,$4)`,[tenantId,saved.id,JSON.stringify(saved),userId]);return saved;});res.status(201).json({...row,token,warning:'Copy this integration key now. It is stored only as a hash and cannot be shown again.'});}catch(e){next(e);}});
  router.post('/platform/integrations/:id',requireWrite('owner'),async(req,res,next)=>{try{const id=uuid.parse(req.params.id);const body=z.object({name:z.string().trim().min(2).max(100),adapter:z.enum(['pull_api','tally','file_exchange','custom']),description:z.string().max(500).default(''),subscriptions:z.array(eventType).max(50).default([]),isActive:z.boolean()}).parse(req.body);const{tenantId,userId}=req.session!;const row=await withTenant(tenantId,userId,async db=>{const before=await one<any>(db,'select * from integration_connection where id=$1',[id]);if(!before)throw new Error('connection not found');const saved=await one<any>(db,'update integration_connection set name=$2,adapter=$3,description=$4,is_active=$5,updated_at=now() where id=$1 returning id,name,adapter,description,token_prefix,is_active',[id,body.name,body.adapter,body.description,body.isActive]);await db.query('update integration_subscription set is_active=false where connection_id=$1',[id]);if(body.subscriptions.length)await db.query(`insert into integration_subscription(tenant_id,connection_id,event_type) select $1,$2,x from unnest($3::text[]) x on conflict(tenant_id,connection_id,event_type) do update set is_active=true`,[tenantId,id,Array.from(new Set(body.subscriptions))]);await db.query(`insert into platform_change_event(tenant_id,area,target_id,action,before_data,after_data,actor_id) values($1,'integration',$2,'updated',$3,$4,$5)`,[tenantId,id,JSON.stringify(before),JSON.stringify(saved),userId]);return saved;});res.json(row);}catch(e){next(e);}});
  router.post('/platform/integrations/:id/token',requireWrite('owner'),async(req,res,next)=>{try{const id=uuid.parse(req.params.id);const token=newToken();const{tenantId,userId}=req.session!;const row=await withTenant(tenantId,userId,async db=>{const saved=await one<any>(db,'update integration_connection set token_hash=$2,token_prefix=$3,updated_at=now() where id=$1 returning id,name,token_prefix',[id,tokenHash(token),token.slice(0,12)]);if(!saved)throw new Error('connection not found');await db.query(`insert into platform_change_event(tenant_id,area,target_id,action,actor_id) values($1,'integration',$2,'token_rotated',$3)`,[tenantId,id,userId]);return saved;});res.json({...row,token,warning:'Copy this replacement key now.'});}catch(e){next(e);}});
  router.post('/platform/integrations/:id/events',requireWrite('owner'),async(req,res,next)=>{try{const connectionId=uuid.parse(req.params.id);const body=z.object({eventType,entityId:uuid,payload:z.record(z.string(),z.unknown())}).parse(req.body);const{tenantId,userId}=req.session!;const row=await withTenant(tenantId,userId,async db=>{if(!await one(db,'select id from integration_connection where id=$1 and is_active',[connectionId]))throw new Error('connection not found');const event=await one<any>(db,'insert into integration_event(tenant_id,event_type,entity_id,payload) values($1,$2,$3,$4) returning id,event_key',[tenantId,body.eventType,body.entityId,JSON.stringify(body.payload)]);const delivery=await one(db,'insert into integration_delivery(tenant_id,event_id,connection_id) values($1,$2,$3) on conflict(tenant_id,event_id,connection_id) do nothing returning id',[tenantId,event!.id,connectionId]);return{...event,deliveryId:(delivery as any)?.id};});res.status(201).json(row);}catch(e){next(e);}});
  return router;
}
