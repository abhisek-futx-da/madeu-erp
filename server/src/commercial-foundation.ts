import { Router } from 'express';
import { z } from 'zod';
import { many, one, withTenant } from './db.ts';
import { requireWrite } from './auth.ts';

const uuid = z.string().uuid();
const code = z.string().trim().min(1).max(30).transform(value => value.toUpperCase());
const role = z.enum(['owner','accounts','purchase','sales','store','viewer']);
const permission = z.enum([
  'write:masters','write:purchase','write:store',
  'write:sales','write:accounts','write:owner'
]);
const openingOutstandingInput=z.object({
  fyLabel:z.string().regex(/^\d{4}-\d{2}$/),kind:z.enum(['receivable','payable']),partyId:uuid,
  referenceNo:z.string().trim().min(1).max(80),documentDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dueDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),originalAmount:z.coerce.number().finite().positive().max(999999999999.99)
}).refine(value=>value.dueDate>=value.documentDate,{path:['dueDate'],message:'due date cannot be before document date'});

export function commercialFoundationRouter() {
  const router = Router();

  router.get('/locations', async (req, res, next) => {
    try {
      const { tenantId, userId } = req.session!;
      const rows = await withTenant(tenantId, userId, db => many(db,
        `select id,code,name,kind,gstin,address,state_code,is_default,is_active
           from business_location order by is_default desc,is_active desc,code`));
      res.json(rows);
    } catch (error) { next(error); }
  });

  router.post('/locations', requireWrite('owner'), async (req, res, next) => {
    try {
      const body = z.object({
        id: uuid.optional(), code, name: z.string().trim().min(2).max(120),
        kind: z.enum(['registered_office','branch','godown','outlet']),
        gstin: z.string().trim().toUpperCase().regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{3}$/).nullish(),
        address: z.string().trim().max(500).default(''),
        stateCode: z.string().regex(/^\d{2}$/), isDefault: z.boolean().default(false),
        isActive: z.boolean().default(true)
      }).parse(req.body);
      const { tenantId, userId } = req.session!;
      const result = await withTenant(tenantId, userId, async db => {
        if (body.id && !body.isActive) {
          const used = await one<{ members: number; racks: number; pieces: number }>(db,
            `select
              (select count(*) from membership where active_location_id=$1 and is_active)::int as members,
              (select count(*) from rack_master where business_location_id=$1)::int as racks,
              (select count(*) from piece where business_location_id=$1 and status<>'consumed')::int as pieces`,
            [body.id]);
          if (used && (used.members > 0 || used.racks > 0 || used.pieces > 0)) {
            throw new Error('move active users, racks and stock before disabling this location');
          }
        }
        if (body.isDefault) {
          await db.query('update business_location set is_default=false where is_default');
        }
        if (!body.isActive && body.isDefault) throw new Error('the default location must remain active');
        if (body.id) {
          const row = await one(db,
            `update business_location set code=$2,name=$3,kind=$4,gstin=$5,address=$6,
                    state_code=$7,is_default=$8,is_active=$9
              where id=$1 returning id,code,name,kind,gstin,address,state_code,is_default,is_active`,
            [body.id,body.code,body.name,body.kind,body.gstin ?? null,body.address,
             body.stateCode,body.isDefault,body.isActive]);
          if (!row) throw new Error('location not found');
          return row;
        }
        return one(db,
          `insert into business_location
             (tenant_id,code,name,kind,gstin,address,state_code,is_default,is_active)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           returning id,code,name,kind,gstin,address,state_code,is_default,is_active`,
          [tenantId,body.code,body.name,body.kind,body.gstin ?? null,body.address,
           body.stateCode,body.isDefault,body.isActive]);
      });
      res.status(body.id ? 200 : 201).json(result);
    } catch (error) { next(error); }
  });

  router.post('/locations/active', async (req, res, next) => {
    try {
      const body = z.object({ locationId: uuid }).parse(req.body);
      const { tenantId, userId } = req.session!;
      const location = await withTenant(tenantId, userId, async db => {
        const row = await one<{ id: string; code: string; name: string }>(db,
          'select id,code,name from business_location where id=$1 and is_active',
          [body.locationId]);
        if (!row) throw new Error('active business location not found');
        await db.query(
          'update membership set active_location_id=$3 where tenant_id=$1 and user_id=$2',
          [tenantId, userId, body.locationId]);
        return row;
      });
      res.json(location);
    } catch (error) { next(error); }
  });

  router.get('/permission-profiles', requireWrite('owner'), async (req, res, next) => {
    try {
      const { tenantId, userId } = req.session!;
      const rows = await withTenant(tenantId, userId, db => many(db,
        `select p.id,p.code,p.name,p.base_role::text,p.permissions,p.is_system,p.is_active,
                count(m.user_id)::int as members
           from permission_profile p left join membership m on m.permission_profile_id=p.id
          group by p.id order by p.is_system desc,p.name`));
      res.json(rows);
    } catch (error) { next(error); }
  });

  router.post('/permission-profiles', requireWrite('owner'), async (req, res, next) => {
    try {
      const body = z.object({
        id: uuid.optional(), code, name: z.string().trim().min(2).max(100),
        baseRole: role, permissions: z.array(permission).max(6), isActive: z.boolean().default(true)
      }).parse(req.body);
      if (body.baseRole === 'owner' && !body.permissions.includes('write:owner')) {
        throw new Error('an owner profile must retain owner administration permission');
      }
      const { tenantId, userId } = req.session!;
      const result = await withTenant(tenantId, userId, async db => {
        if (body.id) {
          const current = await one<{ is_system: boolean; base_role: string; members: number }>(db,
            `select p.is_system,p.base_role::text,count(m.user_id)::int as members
               from permission_profile p left join membership m on m.permission_profile_id=p.id
              where p.id=$1 group by p.id`, [body.id]);
          if (!current) throw new Error('permission profile not found');
          if (current.is_system) throw new Error('system profiles are fixed; create a custom profile instead');
          if (current.members > 0 && (current.base_role !== body.baseRole || !body.isActive)) {
            throw new Error('reassign this profile’s members before changing its role or disabling it');
          }
          return one(db,
            `update permission_profile set code=$2,name=$3,base_role=$4,permissions=$5,is_active=$6
              where id=$1 returning id,code,name,base_role::text,permissions,is_system,is_active`,
            [body.id,body.code,body.name,body.baseRole,body.permissions,body.isActive]);
        }
        return one(db,
          `insert into permission_profile
             (tenant_id,code,name,base_role,permissions,is_system,is_active)
           values ($1,$2,$3,$4,$5,false,$6)
           returning id,code,name,base_role::text,permissions,is_system,is_active`,
          [tenantId,body.code,body.name,body.baseRole,body.permissions,body.isActive]);
      });
      res.status(body.id ? 200 : 201).json(result);
    } catch (error) { next(error); }
  });

  router.get('/saved-views', async (req, res, next) => {
    try {
      const module = z.string().trim().min(1).max(80).parse(req.query.module);
      const { tenantId, userId } = req.session!;
      const rows = await withTenant(tenantId, userId, db => many(db,
        `select id,module,name,filter_text,columns,updated_at from saved_view
          where module=$1 order by name`, [module]));
      res.json(rows);
    } catch (error) { next(error); }
  });

  router.post('/saved-views', async (req, res, next) => {
    try {
      const body = z.object({
        module: z.string().trim().min(1).max(80), name: z.string().trim().min(1).max(100),
        filterText: z.string().max(500).default(''),
        columns: z.array(z.string().min(1).max(80)).max(100).default([])
      }).parse(req.body);
      const { tenantId, userId } = req.session!;
      const row = await withTenant(tenantId, userId, db => one(db,
        `insert into saved_view (tenant_id,user_id,module,name,filter_text,columns)
         values ($1,$2,$3,$4,$5,$6)
         on conflict (tenant_id,user_id,module,name) do update
           set filter_text=excluded.filter_text,columns=excluded.columns,updated_at=now()
         returning id,module,name,filter_text,columns,updated_at`,
        [tenantId,userId,body.module,body.name,body.filterText,body.columns]));
      res.status(201).json(row);
    } catch (error) { next(error); }
  });

  router.delete('/saved-views/:id', async (req, res, next) => {
    try {
      const id = uuid.parse(req.params.id);
      const { tenantId, userId } = req.session!;
      const row = await withTenant(tenantId, userId, db => one(db,
        'delete from saved_view where id=$1 returning id', [id]));
      if (!row) return res.status(404).json({ error: 'saved view not found' });
      res.json({ id, deleted: true });
    } catch (error) { next(error); }
  });

  router.get('/opening-outstandings', requireWrite('owner'), async (req, res, next) => {
    try {
      const query = z.object({ kind: z.enum(['receivable','payable']).optional() }).parse(req.query);
      const { tenantId, userId } = req.session!;
      const rows = await withTenant(tenantId, userId, db => many(db,
        `select o.id,o.fy_label,o.kind::text,o.reference_no,o.document_date,o.due_date,
                o.original_amount,o.status::text,l.id as party_id,l.code as party_code,l.name as party
           from opening_outstanding o join ledger_account l on l.id=o.party_id
          where ($1::text is null or o.kind::text=$1)
          order by o.document_date,o.reference_no`, [query.kind ?? null]));
      res.json(rows);
    } catch (error) { next(error); }
  });

  router.post('/opening-outstandings', requireWrite('owner'), async (req, res, next) => {
    try {
      const body = openingOutstandingInput.parse(req.body);
      const { tenantId, userId } = req.session!;
      const row = await withTenant(tenantId, userId, db => one(db,
        `insert into opening_outstanding
          (tenant_id,fy_label,kind,party_id,reference_no,document_date,due_date,
           original_amount,created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         returning id,fy_label,kind::text,party_id,reference_no,document_date,due_date,
                   original_amount,status::text`,
        [tenantId,body.fyLabel,body.kind,body.partyId,body.referenceNo,
         body.documentDate,body.dueDate,body.originalAmount,userId]));
      res.status(201).json(row);
    } catch (error) { next(error); }
  });

  router.post('/opening-outstandings/batch', requireWrite('owner'), async(req,res,next)=>{
    try{
      const body=z.object({entries:z.array(openingOutstandingInput).min(1).max(2000)}).parse(req.body);
      const keys=body.entries.map(row=>`${row.kind}|${row.partyId}|${row.referenceNo.toUpperCase()}`);
      if(new Set(keys).size!==keys.length) throw new Error('the opening-bill file contains a duplicate party/reference');
      const {tenantId,userId}=req.session!;
      const result=await withTenant(tenantId,userId,async db=>{
        const {rowCount}=await db.query(
          `insert into opening_outstanding
             (tenant_id,fy_label,kind,party_id,reference_no,document_date,due_date,original_amount,created_by)
           select $1,x.fy_label,x.kind::opening_outstanding_kind,x.party_id,x.reference_no,
                  x.document_date,x.due_date,x.amount,$2
             from unnest($3::text[],$4::text[],$5::uuid[],$6::text[],$7::date[],$8::date[],$9::numeric[])
                  as x(fy_label,kind,party_id,reference_no,document_date,due_date,amount)`,
          [tenantId,userId,body.entries.map(row=>row.fyLabel),body.entries.map(row=>row.kind),
           body.entries.map(row=>row.partyId),body.entries.map(row=>row.referenceNo),
           body.entries.map(row=>row.documentDate),body.entries.map(row=>row.dueDate),
           body.entries.map(row=>row.originalAmount)]);
        return {imported:rowCount??0};
      });
      res.status(201).json(result);
    }catch(error){next(error);}
  });

  router.get('/readiness/foundation', requireWrite('owner'), async (req, res, next) => {
    try {
      const { tenantId, userId } = req.session!;
      const result = await withTenant(tenantId, userId, async db => {
        const fy = await one<{ label: string }>(db,
          `select label from financial_year where status='open' order by starts_on desc limit 1`);
        const metrics = await one<{
          active_locations: number; active_users: number; profiled_users: number;
          posted_vouchers: number; stock_value: number; inventory_opening: number;
          receivable_bills: number; receivable_opening: number;
          payable_bills: number; payable_opening: number;
        }>(db, `select
          (select count(*) from business_location where is_active)::int as active_locations,
          (select count(*) from membership where is_active)::int as active_users,
          (select count(*) from membership where is_active and permission_profile_id is not null)::int as profiled_users,
          (select count(*) from voucher where is_posted)::int as posted_vouchers,
          coalesce((select sum(grey_cost+jobwork_cost+other_cost) from piece
            where status in ('grey_in_stock','issued_to_dyeing','received_finish','cut_packed','reprocess_at_process_house')),0) as stock_value,
          coalesce((select sum(ob.debit-ob.credit) from opening_balance ob
            join ledger_account l on l.id=ob.ledger_id
            where ob.fy_label=$1 and l.posting_role in ('inventory_grey','inventory_finish')),0) as inventory_opening,
          coalesce((select sum(original_amount) from opening_outstanding
            where fy_label=$1 and kind='receivable' and status='open'),0) as receivable_bills,
          coalesce((select sum(ob.debit-ob.credit) from opening_balance ob
            join ledger_account l on l.id=ob.ledger_id join control_account c on c.id=l.control_account_id
            where ob.fy_label=$1 and c.nature='sundry_debtor_finish'),0) as receivable_opening,
          coalesce((select sum(original_amount) from opening_outstanding
            where fy_label=$1 and kind='payable' and status='open'),0) as payable_bills,
          coalesce((select sum(ob.credit-ob.debit) from opening_balance ob
            join ledger_account l on l.id=ob.ledger_id join control_account c on c.id=l.control_account_id
            where ob.fy_label=$1 and c.nature::text like 'sundry_creditor_%'),0) as payable_opening`,
          [fy?.label ?? '']);
        if (!metrics) throw new Error('readiness metrics returned nothing');
        const close = (left: number, right: number) => Math.abs(Number(left)-Number(right)) <= 0.01;
        const checks = [
          { key: 'financial_year', label: 'Open financial year configured', pass: Boolean(fy), detail: fy?.label ?? 'Missing' },
          { key: 'locations', label: 'At least one active business location', pass: metrics.active_locations > 0, detail: `${metrics.active_locations} active` },
          { key: 'permissions', label: 'Every active user has a permission profile', pass: metrics.active_users === metrics.profiled_users, detail: `${metrics.profiled_users}/${metrics.active_users} assigned` },
          { key: 'inventory', label: 'Physical opening stock matches inventory opening ledgers', pass: close(metrics.stock_value,metrics.inventory_opening), detail: `Stock ₹${Number(metrics.stock_value).toFixed(2)} · books ₹${Number(metrics.inventory_opening).toFixed(2)}` },
          { key: 'receivables', label: 'Opening receivable bills match debtor openings', pass: close(metrics.receivable_bills,metrics.receivable_opening), detail: `Bills ₹${Number(metrics.receivable_bills).toFixed(2)} · books ₹${Number(metrics.receivable_opening).toFixed(2)}` },
          { key: 'payables', label: 'Opening payable bills match creditor openings', pass: close(metrics.payable_bills,metrics.payable_opening), detail: `Bills ₹${Number(metrics.payable_bills).toFixed(2)} · books ₹${Number(metrics.payable_opening).toFixed(2)}` }
        ];
        return { fyLabel: fy?.label ?? null, postedVouchers: metrics.posted_vouchers,
          ready: checks.every(check => check.pass), checks };
      });
      res.json(result);
    } catch (error) { next(error); }
  });

  return router;
}
