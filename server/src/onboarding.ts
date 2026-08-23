import { Router } from 'express';
import { z } from 'zod';
import { many, one, withTenant, type Db } from './db.ts';
import { requireWrite } from './auth.ts';
import { sendCsv } from './listing.ts';

type Cell = string | number | boolean | null;
type RawRow = Record<string, Cell>;
type Normalized = Record<string, unknown>;

interface ImportSpec {
  columns: string[];
  key: string;
  schema: z.ZodType<Normalized>;
  existingSql: string;
  template: RawRow;
}

const cleanText = (max: number) => z.preprocess(
  value => typeof value === 'string' ? value.trim() : value,
  z.string().min(1).max(max)
);
const upperText = (max: number) => cleanText(max).transform(value => value.toUpperCase());
const optionalText = (max: number) => z.preprocess(
  value => value === null || value === undefined || String(value).trim() === ''
    ? null : String(value).trim(),
  z.string().max(max).nullable()
);
const optionalUpper = (max: number) => optionalText(max).transform(value => value?.toUpperCase() ?? null);
const numberCell = (min: number, max: number) => z.preprocess(
  value => typeof value === 'string' ? value.trim() : value,
  z.coerce.number().finite().min(min).max(max)
);
const optionalNumber = (min: number, max: number) => z.preprocess(
  value => value === null || value === undefined || String(value).trim() === '' ? null : value,
  z.coerce.number().finite().min(min).max(max).nullable()
);
const boolCell = (fallback: boolean) => z.preprocess(value => {
  if (value === null || value === undefined || String(value).trim() === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1 ? true : value === 0 ? false : value;
  const normalized = String(value).trim().toLowerCase();
  if (['true', 'yes', 'y', '1'].includes(normalized)) return true;
  if (['false', 'no', 'n', '0'].includes(normalized)) return false;
  return value;
}, z.boolean());

const specs = {
  grades: {
    columns: ['code', 'name', 'sort_order'], key: 'code',
    schema: z.object({
      code: upperText(20), name: cleanText(100),
      sort_order: numberCell(-32768, 32767).default(0)
    }).strict(),
    existingSql: 'select code from grade',
    template: { code: 'A', name: 'First Quality', sort_order: 1 }
  },
  'hsn-codes': {
    columns: ['code', 'description', 'gst_rate', 'is_service'], key: 'code',
    schema: z.object({
      code: cleanText(8).refine(value => /^\d{4,8}$/.test(value), 'must be 4 to 8 digits'),
      description: cleanText(200),
      gst_rate: numberCell(0, 28).refine(value => [0, 0.25, 3, 5, 12, 18, 28].includes(value), 'unsupported GST rate'),
      is_service: boolCell(false)
    }).strict(),
    existingSql: 'select code from hsn_code',
    template: { code: '5208', description: 'Woven cotton fabric', gst_rate: 5, is_service: false }
  },
  units: {
    columns: ['code', 'name', 'uqc'], key: 'code',
    schema: z.object({ code: upperText(20), name: cleanText(100), uqc: upperText(20) }).strict(),
    existingSql: 'select code from unit_master',
    template: { code: 'MTR', name: 'Metres', uqc: 'MTR' }
  },
  widths: {
    columns: ['code', 'cms', 'inches'], key: 'code',
    schema: z.object({
      code: upperText(30), cms: numberCell(0.01, 9999.99), inches: optionalNumber(0.01, 9999.99)
    }).strict(),
    existingSql: 'select code from width_master',
    template: { code: '58IN', cms: 147.32, inches: 58 }
  },
  racks: {
    columns: ['code', 'name', 'location'], key: 'code',
    schema: z.object({
      code: upperText(30), name: cleanText(100), location: optionalText(200).transform(value => value ?? '')
    }).strict(),
    existingSql: 'select code from rack_master',
    template: { code: 'A-01', name: 'Rack A-01', location: 'Main godown' }
  },
  qualities: {
    columns: ['code', 'name', 'construction', 'selvedge_line', 'width_cms', 'bill_by',
      'hsn_code', 'division', 'is_active'], key: 'code',
    schema: z.object({
      code: upperText(30), name: cleanText(150),
      construction: optionalText(150).transform(value => value ?? ''),
      selvedge_line: optionalText(150).transform(value => value ?? ''),
      width_cms: optionalNumber(0.01, 9999.99),
      bill_by: z.preprocess(value => String(value ?? 'meters').trim().toLowerCase(),
        z.enum(['meters', 'pcs', 'weight'])),
      hsn_code: cleanText(8),
      division: optionalText(100).transform(value => value ?? ''),
      is_active: boolCell(true)
    }).strict(),
    existingSql: 'select code from quality',
    template: {
      code: 'POP58', name: 'Poplin 58', construction: '40x40/132x72', selvedge_line: '',
      width_cms: 147.32, bill_by: 'meters', hsn_code: '5208', division: 'Shirting', is_active: true
    }
  },
  ledgers: {
    columns: ['code', 'name', 'alias', 'control_account_code', 'gstin', 'pan', 'gst_reg_type',
      'is_msme', 'msme_ref_no', 'auto_tds_tcs', 'rcm_applicable', 'credit_days',
      'credit_limit', 'mobile_e164', 'is_active'], key: 'code',
    schema: z.object({
      code: upperText(30), name: cleanText(150),
      alias: optionalText(100).transform(value => value ?? ''),
      control_account_code: upperText(30),
      gstin: optionalUpper(15).refine(value => value === null || /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{3}$/.test(value), 'invalid GSTIN'),
      pan: optionalUpper(10).refine(value => value === null || /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(value), 'invalid PAN'),
      gst_reg_type: z.preprocess(value => String(value ?? 'unregistered').trim().toLowerCase(),
        z.enum(['regular', 'composition', 'unregistered', 'sez', 'overseas'])),
      is_msme: boolCell(false), msme_ref_no: optionalText(100),
      auto_tds_tcs: boolCell(false), rcm_applicable: boolCell(false),
      credit_days: numberCell(0, 3650).pipe(z.number().int()).default(0),
      credit_limit: numberCell(0, 999999999999.99).default(0),
      mobile_e164: optionalText(16).refine(value => value === null || /^\+[1-9][0-9]{7,14}$/.test(value), 'use +country-code format'),
      is_active: boolCell(true)
    }).strict().superRefine((row, ctx) => {
      if (['regular', 'composition'].includes(row.gst_reg_type) && !row.gstin) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['gstin'], message: 'required for a registered party' });
      }
    }),
    existingSql: 'select code from ledger_account',
    template: {
      code: 'CUST001', name: 'Customer name', alias: '', control_account_code: 'DEBTOR',
      gstin: '', pan: '', gst_reg_type: 'unregistered', is_msme: false, msme_ref_no: '',
      auto_tds_tcs: false, rcm_applicable: false, credit_days: 30, credit_limit: 100000,
      mobile_e164: '', is_active: true
    }
  }
} satisfies Record<string, ImportSpec>;

type Resource = keyof typeof specs;
const resourceSchema = z.enum(Object.keys(specs) as [Resource, ...Resource[]]);

interface EvaluatedRow {
  row_no: number;
  raw_data: RawRow;
  normalized_data: Normalized;
  action: 'insert' | 'update' | 'error';
  errors: string[];
}

const issueText = (issue: z.ZodIssue) =>
  `${issue.path.length > 0 ? issue.path.join('.') : 'row'}: ${issue.message}`;

async function evaluateRows(db: Db, resource: Resource, rows: RawRow[]): Promise<EvaluatedRow[]> {
  const spec = specs[resource];
  const existing = new Set((await many<{ code: string }>(db, spec.existingSql)).map(row => row.code));
  const hsn = resource === 'qualities'
    ? new Set((await many<{ code: string }>(db, 'select code from hsn_code')).map(row => row.code))
    : null;
  const controls = resource === 'ledgers'
    ? new Set((await many<{ code: string }>(db, 'select code from control_account')).map(row => row.code))
    : null;

  const evaluated = rows.map((raw, index): EvaluatedRow => {
    const parsed = spec.schema.safeParse(raw);
    if (!parsed.success) {
      return {
        row_no: index + 2, raw_data: raw, normalized_data: {}, action: 'error',
        errors: parsed.error.issues.map(issueText)
      };
    }
    // The selected resource fixes the schema at runtime.  Widen the inferred
    // union only after a successful parse so shared reference checks can use
    // the resource-specific column names without weakening validation.
    const normalized = parsed.data as Normalized;
    const errors: string[] = [];
    if (hsn && !hsn.has(String(normalized.hsn_code))) errors.push(`hsn_code: ${normalized.hsn_code} does not exist`);
    if (controls && !controls.has(String(normalized.control_account_code))) {
      errors.push(`control_account_code: ${normalized.control_account_code} does not exist`);
    }
    const key = String(normalized[spec.key]);
    return {
      row_no: index + 2, raw_data: raw, normalized_data: normalized,
      action: errors.length > 0 ? 'error' : existing.has(key) ? 'update' : 'insert', errors
    };
  });

  const occurrences = new Map<string, number[]>();
  for (let index = 0; index < evaluated.length; index++) {
    const key = evaluated[index]!.normalized_data[spec.key];
    if (key === undefined) continue;
    const bucket = occurrences.get(String(key)) ?? [];
    bucket.push(index);
    occurrences.set(String(key), bucket);
  }
  for (const [key, indexes] of occurrences) {
    if (indexes.length < 2) continue;
    for (const index of indexes) {
      const row = evaluated[index]!;
      row.errors.push(`${spec.key}: duplicate ${key} within this file`);
      row.action = 'error';
    }
  }
  return evaluated;
}

async function applyRows(db: Db, tenantId: string, resource: Resource, rows: Normalized[]) {
  const json = JSON.stringify(rows);
  let sql: string;
  switch (resource) {
    case 'grades':
      sql = `insert into grade (tenant_id,code,name,sort_order)
             select $1,x.code,x.name,x.sort_order from jsonb_to_recordset($2::jsonb)
               as x(code text,name text,sort_order smallint)
             on conflict (tenant_id,code) do update set name=excluded.name,sort_order=excluded.sort_order`;
      break;
    case 'hsn-codes':
      sql = `insert into hsn_code (tenant_id,code,description,gst_rate,is_service)
             select $1,x.code,x.description,x.gst_rate,x.is_service from jsonb_to_recordset($2::jsonb)
               as x(code text,description text,gst_rate numeric,is_service boolean)
             on conflict (tenant_id,code) do update set description=excluded.description,
               gst_rate=excluded.gst_rate,is_service=excluded.is_service`;
      break;
    case 'units':
      sql = `insert into unit_master (tenant_id,code,name,uqc)
             select $1,x.code,x.name,x.uqc from jsonb_to_recordset($2::jsonb)
               as x(code text,name text,uqc text)
             on conflict (tenant_id,code) do update set name=excluded.name,uqc=excluded.uqc`;
      break;
    case 'widths':
      sql = `insert into width_master (tenant_id,code,cms,inches)
             select $1,x.code,x.cms,x.inches from jsonb_to_recordset($2::jsonb)
               as x(code text,cms numeric,inches numeric)
             on conflict (tenant_id,code) do update set cms=excluded.cms,inches=excluded.inches`;
      break;
    case 'racks':
      sql = `insert into rack_master (tenant_id,code,name,location)
             select $1,x.code,x.name,x.location from jsonb_to_recordset($2::jsonb)
               as x(code text,name text,location text)
             on conflict (tenant_id,code) do update set name=excluded.name,location=excluded.location`;
      break;
    case 'qualities':
      sql = `insert into quality (tenant_id,code,name,construction,selvedge_line,width_cms,
                                  bill_by,hsn_code,division,is_active)
             select $1,x.code,x.name,x.construction,x.selvedge_line,x.width_cms,
                    x.bill_by::bill_by,x.hsn_code,x.division,x.is_active
               from jsonb_to_recordset($2::jsonb) as x(code text,name text,construction text,
                 selvedge_line text,width_cms numeric,bill_by text,hsn_code text,division text,is_active boolean)
             on conflict (tenant_id,code) do update set name=excluded.name,
               construction=excluded.construction,selvedge_line=excluded.selvedge_line,
               width_cms=excluded.width_cms,bill_by=excluded.bill_by,hsn_code=excluded.hsn_code,
               division=excluded.division,is_active=excluded.is_active`;
      break;
    case 'ledgers':
      sql = `insert into ledger_account (tenant_id,code,name,alias,control_account_id,gstin,pan,
                    gst_reg_type,is_msme,msme_ref_no,auto_tds_tcs,rcm_applicable,credit_days,
                    credit_limit,mobile_e164,is_active)
             select $1,x.code,x.name,x.alias,c.id,x.gstin,x.pan,x.gst_reg_type::gst_reg_type,
                    x.is_msme,x.msme_ref_no,x.auto_tds_tcs,x.rcm_applicable,x.credit_days,
                    x.credit_limit,x.mobile_e164,x.is_active
               from jsonb_to_recordset($2::jsonb) as x(code text,name text,alias text,
                 control_account_code text,gstin text,pan text,gst_reg_type text,is_msme boolean,
                 msme_ref_no text,auto_tds_tcs boolean,rcm_applicable boolean,credit_days smallint,
                 credit_limit numeric,mobile_e164 text,is_active boolean)
               join control_account c on c.tenant_id=$1 and c.code=x.control_account_code
             on conflict (tenant_id,code) do update set name=excluded.name,alias=excluded.alias,
               control_account_id=excluded.control_account_id,gstin=excluded.gstin,pan=excluded.pan,
               gst_reg_type=excluded.gst_reg_type,is_msme=excluded.is_msme,
               msme_ref_no=excluded.msme_ref_no,auto_tds_tcs=excluded.auto_tds_tcs,
               rcm_applicable=excluded.rcm_applicable,credit_days=excluded.credit_days,
               credit_limit=excluded.credit_limit,mobile_e164=excluded.mobile_e164,
               is_active=excluded.is_active`;
      break;
  }
  const result = await db.query(sql, [tenantId, json]);
  if (result.rowCount !== rows.length) throw new Error('a referenced master changed after preview; preview the file again');
}

const batchSelect = `select id,resource,filename,status,total_rows,valid_rows,error_rows,
                            created_by,created_at,applied_at from data_import`;

export function onboardingRouter() {
  const r = Router();

  r.get('/templates/:resource', (req, res) => {
    const resource = resourceSchema.parse(req.params.resource);
    sendCsv(res, `${resource}-import-template`, [specs[resource].template]);
  });

  r.get('/imports', async (req, res, next) => {
    try {
      const { tenantId, userId } = req.session!;
      const rows = await withTenant(tenantId, userId, db => many(db,
        `${batchSelect} order by created_at desc limit 50`));
      res.json(rows);
    } catch (error) { next(error); }
  });

  r.get('/imports/:id', async (req, res, next) => {
    try {
      const id = z.string().uuid().parse(req.params.id);
      const { tenantId, userId } = req.session!;
      const detail = await withTenant(tenantId, userId, async db => {
        const batch = await one(db, `${batchSelect} where id=$1`, [id]);
        if (!batch) return null;
        const rows = await many(db,
          `select row_no,raw_data,normalized_data,action,errors
             from data_import_row where import_id=$1 order by row_no`, [id]);
        return { batch, rows };
      });
      if (!detail) return res.status(404).json({ error: 'import not found' });
      res.json(detail);
    } catch (error) { next(error); }
  });

  r.get('/imports/:id/rejections', async (req, res, next) => {
    try {
      const id = z.string().uuid().parse(req.params.id);
      const { tenantId, userId } = req.session!;
      const rows = await withTenant(tenantId, userId, db => many<{
        row_no: number; raw_data: RawRow; errors: string[]
      }>(db, `select row_no,raw_data,errors from data_import_row
                where import_id=$1 and action='error' order by row_no`, [id]));
      sendCsv(res, 'import-rejections', rows.map(row => ({
        row_no: row.row_no, errors: row.errors.join('; '), ...row.raw_data
      })));
    } catch (error) { next(error); }
  });

  r.post('/imports/preview', requireWrite('owner'), async (req, res, next) => {
    try {
      const body = z.object({
        resource: resourceSchema,
        filename: z.string().trim().min(1).max(180),
        rows: z.array(z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])))
          .min(1).max(2000)
      }).parse(req.body);
      const { tenantId, userId } = req.session!;
      const result = await withTenant(tenantId, userId, async db => {
        const evaluated = await evaluateRows(db, body.resource, body.rows);
        const errorRows = evaluated.filter(row => row.action === 'error').length;
        const batch = await one<{ id: string }>(db,
          `insert into data_import (tenant_id,resource,filename,total_rows,valid_rows,error_rows,created_by)
           values ($1,$2,$3,$4,$5,$6,$7) returning id`,
          [tenantId, body.resource, body.filename, evaluated.length, evaluated.length - errorRows,
           errorRows, userId]);
        if (!batch) throw new Error('could not create import preview');
        await db.query(
          `insert into data_import_row
             (tenant_id,import_id,row_no,raw_data,normalized_data,action,errors)
           select $1,$2,x.row_no,x.raw_data,x.normalized_data,x.action::data_import_action,x.errors
             from jsonb_to_recordset($3::jsonb)
               as x(row_no integer,raw_data jsonb,normalized_data jsonb,action text,errors text[])`,
          [tenantId, batch.id, JSON.stringify(evaluated)]
        );
        return { id: batch.id, totalRows: evaluated.length,
          validRows: evaluated.length - errorRows, errorRows, rows: evaluated };
      });
      res.status(201).json(result);
    } catch (error) { next(error); }
  });

  r.post('/imports/:id/apply', requireWrite('owner'), async (req, res, next) => {
    try {
      const id = z.string().uuid().parse(req.params.id);
      const { tenantId, userId } = req.session!;
      const result = await withTenant(tenantId, userId, async db => {
        const batch = await one<{ resource: Resource; status: string; error_rows: number }>(db,
          `select resource,status,error_rows from data_import where id=$1 for update`, [id]);
        if (!batch) throw new Error('import not found');
        if (batch.status !== 'previewed') throw new Error('this import has already been completed');
        if (batch.error_rows > 0) throw new Error('fix every rejected row and preview the file again');
        const rows = await many<{ normalized_data: Normalized }>(db,
          `select normalized_data from data_import_row where import_id=$1 order by row_no`, [id]);
        await applyRows(db, tenantId, batch.resource, rows.map(row => row.normalized_data));
        await db.query(`update data_import set status='applied',applied_at=now() where id=$1`, [id]);
        return { id, resource: batch.resource, appliedRows: rows.length, status: 'applied' };
      });
      res.json(result);
    } catch (error) { next(error); }
  });

  r.post('/imports/:id/reject', requireWrite('owner'), async (req, res, next) => {
    try {
      const id = z.string().uuid().parse(req.params.id);
      const { tenantId, userId } = req.session!;
      const row = await withTenant(tenantId, userId, db => one(db,
        `update data_import set status='rejected' where id=$1 and status='previewed' returning id`, [id]));
      if (!row) return res.status(404).json({ error: 'open import not found' });
      res.json({ id, status: 'rejected' });
    } catch (error) { next(error); }
  });

  return r;
}
