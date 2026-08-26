import { Router } from 'express';
import { z } from 'zod';
import { many, one, withTenant } from './db.ts';
import { requireWrite } from './auth.ts';

/**
 * Table-driven CRUD. Eight masters differ only by table name and column list,
 * so they share one router rather than eight near-identical files.
 * Column lists are literals in this file — never anything user-supplied.
 */
interface Resource {
  table: string;
  columns: string[];
  orderBy: string;
  area: 'masters' | 'purchase' | 'sales';
  search?: string[];
  /** Columns of the unique index that makes a save idempotent. */
  conflict: string[];
  /** Composite-PK masters (grade, hsn_code) have no surrogate id column. */
  hasId?: boolean;
}

const RESOURCES: Record<string, Resource> = {
  'control-accounts': {
    table: 'control_account',
    columns: ['code', 'name', 'sub_control', 'nature'],
    orderBy: 'code', area: 'masters', search: ['code', 'name'],
    conflict: ['tenant_id', 'code'], hasId: true
  },
  ledgers: {
    table: 'ledger_account',
    columns: [
      'code', 'name', 'alias', 'control_account_id', 'broker_id', 'transport_id',
      'gstin', 'pan', 'gst_reg_type', 'is_msme', 'msme_ref_no', 'auto_tds_tcs',
      'rcm_applicable', 'credit_days', 'credit_limit', 'mobile_e164', 'is_active'
    ],
    orderBy: 'name', area: 'masters', search: ['code', 'name', 'alias', 'gstin', 'mobile_e164'],
    conflict: ['tenant_id', 'code'], hasId: true
  },
  qualities: {
    table: 'quality',
    columns: ['code', 'name', 'construction', 'selvedge_line', 'width_cms', 'bill_by',
              'hsn_code', 'division', 'is_active'],
    orderBy: 'name', area: 'masters', search: ['code', 'name'],
    conflict: ['tenant_id', 'code'], hasId: true
  },
  designs: {
    table: 'design',
    columns: ['quality_id', 'code', 'name'],
    orderBy: 'code', area: 'masters', search: ['code', 'name'],
    conflict: ['tenant_id', 'quality_id', 'code'], hasId: true
  },
  'hsn-codes': {
    table: 'hsn_code',
    columns: ['code', 'description', 'gst_rate', 'is_service'],
    orderBy: 'code', area: 'masters', search: ['code', 'description'],
    conflict: ['tenant_id', 'code']
  },
  units: {
    table: 'unit_master',
    columns: ['code', 'name', 'uqc'],
    orderBy: 'code', area: 'masters', search: ['code', 'name'],
    conflict: ['tenant_id', 'code']
  },
  widths: {
    table: 'width_master',
    columns: ['code', 'cms', 'inches'],
    orderBy: 'cms', area: 'masters', search: ['code'],
    conflict: ['tenant_id', 'code']
  },
  divisions: {
    table: 'division',
    columns: ['code', 'name', 'sort_order', 'is_active'],
    orderBy: 'sort_order', area: 'masters', search: ['code', 'name'],
    conflict: ['tenant_id', 'code']
  },
  racks: {
    table: 'rack_master',
    columns: ['code', 'name', 'location', 'business_location_id'],
    orderBy: 'code', area: 'masters', search: ['code', 'name', 'location'],
    conflict: ['tenant_id', 'code']
  },
  'bank-accounts': {
    table: 'bank_account',
    columns: ['ledger_id', 'bank_name', 'account_no', 'ifsc', 'branch', 'is_default'],
    orderBy: 'bank_name', area: 'masters', search: ['bank_name', 'account_no'],
    conflict: ['tenant_id', 'account_no'], hasId: true
  },
  grades: {
    table: 'grade',
    columns: ['code', 'name', 'sort_order'],
    orderBy: 'sort_order', area: 'masters', search: ['code', 'name'],
    conflict: ['tenant_id', 'code']
  }
};

const ident = (s: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`unsafe identifier: ${s}`);
  return s;
};

export function resourceRouter() {
  const r = Router();

  r.get('/:resource', async (req, res, next) => {
    try {
      const spec = RESOURCES[req.params.resource];
      if (!spec) return res.status(404).json({ error: 'unknown resource' });
      const { tenantId, userId } = req.session!;

      const q = z.object({
        q: z.string().max(120).optional(),
        limit: z.coerce.number().int().min(1).max(500).default(200),
        offset: z.coerce.number().int().min(0).default(0)
      }).parse(req.query);

      const cols = (spec.hasId ? ['id', ...spec.columns] : spec.columns).map(ident).join(', ');
      const params: unknown[] = [];
      let where = '';
      if (q.q && spec.search?.length) {
        params.push(`%${q.q}%`);
        where = 'where ' + spec.search.map(c => `${ident(c)}::text ilike $1`).join(' or ');
      }
      params.push(q.limit, q.offset);

      const rows = await withTenant(tenantId, userId, db =>
        many(db,
          `select ${cols} from ${ident(spec.table)} ${where}
            order by ${ident(spec.orderBy)} limit $${params.length - 1} offset $${params.length}`,
          params)
      );
      res.json(rows);
    } catch (e) { next(e); }
  });

  r.post('/:resource', async (req, res, next) => {
    try {
      const spec = RESOURCES[req.params.resource];
      if (!spec) return res.status(404).json({ error: 'unknown resource' });
      requireWrite(spec.area)(req, res, async () => {
        try {
          const { tenantId, userId, activeLocationId } = req.session!;
          const body = { ...(req.body as Record<string, unknown>) };
          if (req.params.resource === 'racks' && body.business_location_id === undefined) {
            body.business_location_id = activeLocationId;
          }
          const present = spec.columns.filter(c => body[c] !== undefined);
          if (present.length === 0) return res.status(400).json({ error: 'no known columns supplied' });

          const cols = present.map(ident);
          const placeholders = cols.map((_, i) => `$${i + 2}`);
          const updates = cols.map((c, i) => `${c} = $${i + 2}`);

          const target = spec.conflict.map(ident).join(', ');
          const returning = spec.hasId ? `id, ${cols.join(', ')}` : cols.join(', ');

          const row = await withTenant(tenantId, userId, db =>
            one(db,
              `insert into ${ident(spec.table)} (tenant_id, ${cols.join(', ')})
               values ($1, ${placeholders.join(', ')})
               on conflict (${target}) do update set ${updates.join(', ')}
               returning ${returning}`,
              [tenantId, ...present.map(c => body[c])])
          );
          res.status(201).json(row);
        } catch (e) { next(e); }
      });
    } catch (e) { next(e); }
  });

  return r;
}
