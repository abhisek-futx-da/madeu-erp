import { Router } from 'express';
import { z } from 'zod';
import { requireWrite } from './auth.ts';
import { many, one, withTenant, type Db } from './db.ts';
import { rateFor } from './config.ts';

const uuid = z.string().uuid();
const amount = z.coerce.number().finite().nonnegative();
const fyLabel = z.string().regex(/^\d{4}-\d{2}$/);

async function audit(
  db: Db, tenantId: string, userId: string,
  area: string, event: string, details: unknown
) {
  await db.query(
    `insert into configuration_audit (tenant_id, actor_id, area, event, details)
     values ($1,$2,$3,$4,$5::jsonb)`,
    [tenantId, userId, area, event, JSON.stringify(details)]
  );
}

export function configurationRouter() {
  const r = Router();

  r.get('/', async (req, res, next) => {
    try {
      const { tenantId, userId } = req.session!;
      const out = await withTenant(tenantId, userId, async db => {
        const settings = await many(db, `select key, value, updated_at from tenant_setting order by key`);
        const shrinkage = await many(db,
              `select sp.id, sp.quality_id, q.name as quality,
                      sp.process_house_id, ph.name as process_house,
                      sp.warn_pct, sp.max_pct, sp.gain_pct
                 from shrinkage_policy sp
                 left join quality q on q.id = sp.quality_id
                 left join ledger_account ph on ph.id = sp.process_house_id
                order by (sp.quality_id is not null), (sp.process_house_id is not null),
                         q.name nulls first, ph.name nulls first`);
        const brokerage = await many(db,
              `select br.id, br.broker_id, b.name as broker, br.party_id, p.name as party,
                      br.doc_type, br.basis::text, br.rate
                 from brokerage_rule br
                 join ledger_account b on b.id = br.broker_id
                 left join ledger_account p on p.id = br.party_id
                order by b.name, p.name nulls first, br.doc_type`);
        const rates = await many(db,
              `select rc.id, rc.party_id, p.name as party, rc.quality_id,
                      q.name as quality, rc.kind, rc.rate,
                      rc.valid_from, rc.valid_to
                 from rate_contract rc
                 join ledger_account p on p.id=rc.party_id
                 left join quality q on q.id=rc.quality_id
                order by p.name, rc.kind, q.name nulls first, rc.valid_from desc`);
        const tdsSections = await many(db,
              `select code, kind::text, description, rate, rate_no_pan,
                      threshold, basis::text, applies_to
                 from tax_deduction_section order by code`);
        const series = await many(db,
              `select doc_type, fy_label, prefix, next_number
                 from document_series order by fy_label desc, doc_type`);
        const ledgerTds = await many(db,
              `select la.id as ledger_id, la.name as ledger, la.tds_section
                 from ledger_account la
                where la.is_active and (la.auto_tds_tcs or la.tds_section is not null)
                order by la.name`);
        const auditRows = await many(db,
              `select area, event, details, occurred_at
                 from configuration_audit order by occurred_at desc limit 50`);
        return { settings, shrinkage, brokerage, rates, tdsSections, series, ledgerTds, audit: auditRows };
      });
      res.json(out);
    } catch (e) { next(e); }
  });

  r.post('/settings', requireWrite('owner'), async (req, res, next) => {
    try {
      const body = z.object({
        invoiceRounding: z.enum(['nearest_rupee', 'none']),
        enforceCreditLimit: z.boolean()
      }).parse(req.body);
      const values: Array<[string, unknown]> = [
        ['invoice.rounding', body.invoiceRounding],
        ['credit.enforce_limit', body.enforceCreditLimit]
      ];
      const { tenantId, userId } = req.session!;
      await withTenant(tenantId, userId, async db => {
        for (const [key, value] of values) {
          await db.query(
            `insert into tenant_setting (tenant_id, key, value, updated_at)
             values ($1,$2,$3::jsonb,now())
             on conflict (tenant_id, key) do update
               set value = excluded.value, updated_at = now()`,
            [tenantId, key, JSON.stringify(value)]
          );
        }
        await audit(db, tenantId, userId, 'settings', 'updated', body);
      });
      res.json({ saved: true });
    } catch (e) { next(e); }
  });

  r.post('/document-series', requireWrite('owner'), async (req, res, next) => {
    try {
      const body = z.object({
        docType: z.string().min(1).max(60), fyLabel,
        prefix: z.string().max(30).regex(/^[A-Za-z0-9/_-]*$/)
      }).parse(req.body);
      const { tenantId, userId } = req.session!;
      const row = await withTenant(tenantId, userId, async db => {
        const updated = await one(db,
          `update document_series set prefix = $1
            where doc_type = $2 and fy_label = $3
            returning doc_type, fy_label, prefix, next_number`,
          [body.prefix, body.docType, body.fyLabel]);
        if (!updated) throw new Error('document series does not exist');
        await audit(db, tenantId, userId, 'document_series', 'prefix_changed', body);
        return updated;
      });
      res.json(row);
    } catch (e) { next(e); }
  });

  r.post('/shrinkage', requireWrite('owner'), async (req, res, next) => {
    try {
      const body = z.object({
        id: uuid.optional(), qualityId: uuid.nullable().default(null),
        processHouseId: uuid.nullable().default(null),
        warnPct: amount.max(100), maxPct: amount.max(100), gainPct: amount.max(100)
      }).refine(v => v.warnPct <= v.maxPct, 'warning must not exceed maximum').parse(req.body);
      const { tenantId, userId } = req.session!;
      const row = await withTenant(tenantId, userId, async db => {
        const saved = body.id
          ? await one(db,
              `update shrinkage_policy
                  set quality_id=$1, process_house_id=$2, warn_pct=$3, max_pct=$4, gain_pct=$5
                where id=$6
                returning id, quality_id, process_house_id, warn_pct, max_pct, gain_pct`,
              [body.qualityId, body.processHouseId, body.warnPct, body.maxPct, body.gainPct, body.id])
          : await one(db,
              `insert into shrinkage_policy
                 (tenant_id, quality_id, process_house_id, warn_pct, max_pct, gain_pct)
               values ($1,$2,$3,$4,$5,$6)
               returning id, quality_id, process_house_id, warn_pct, max_pct, gain_pct`,
              [tenantId, body.qualityId, body.processHouseId, body.warnPct, body.maxPct, body.gainPct]);
        if (!saved) throw new Error('shrinkage policy does not exist');
        await audit(db, tenantId, userId, 'shrinkage', body.id ? 'updated' : 'created', body);
        return saved;
      });
      res.json(row);
    } catch (e) { next(e); }
  });

  r.delete('/shrinkage/:id', requireWrite('owner'), async (req, res, next) => {
    try {
      const id = uuid.parse(req.params.id);
      const { tenantId, userId } = req.session!;
      await withTenant(tenantId, userId, async db => {
        const removed = await one(db, 'delete from shrinkage_policy where id=$1 returning id', [id]);
        if (!removed) throw new Error('shrinkage policy does not exist');
        await audit(db, tenantId, userId, 'shrinkage', 'deleted', { id });
      });
      res.json({ deleted: true });
    } catch (e) { next(e); }
  });

  r.post('/brokerage', requireWrite('owner'), async (req, res, next) => {
    try {
      const body = z.object({
        id: uuid.optional(), brokerId: uuid, partyId: uuid.nullable().default(null),
        // Purchase brokerage can be capitalised or expensed depending on the
        // mill's CA policy. Until that treatment is implemented, accepting a
        // purchase rule here would be a configuration screen that lies.
        docType: z.literal('sales_invoice'),
        basis: z.enum(['percent_of_value', 'per_unit', 'flat']),
        rate: amount
      }).parse(req.body);
      const { tenantId, userId } = req.session!;
      const row = await withTenant(tenantId, userId, async db => {
        const saved = body.id
          ? await one(db,
              `update brokerage_rule
                  set broker_id=$1, party_id=$2, doc_type=$3, basis=$4, rate=$5
                where id=$6
                returning id, broker_id, party_id, doc_type, basis, rate`,
              [body.brokerId, body.partyId, body.docType, body.basis, body.rate, body.id])
          : await one(db,
              `insert into brokerage_rule
                 (tenant_id, broker_id, party_id, doc_type, basis, rate)
               values ($1,$2,$3,$4,$5,$6)
               returning id, broker_id, party_id, doc_type, basis, rate`,
              [tenantId, body.brokerId, body.partyId, body.docType, body.basis, body.rate]);
        if (!saved) throw new Error('brokerage rule does not exist');
        await audit(db, tenantId, userId, 'brokerage', body.id ? 'updated' : 'created', body);
        return saved;
      });
      res.json(row);
    } catch (e) { next(e); }
  });

  r.delete('/brokerage/:id', requireWrite('owner'), async (req, res, next) => {
    try {
      const id = uuid.parse(req.params.id);
      const { tenantId, userId } = req.session!;
      await withTenant(tenantId, userId, async db => {
        const removed = await one(db, 'delete from brokerage_rule where id=$1 returning id', [id]);
        if (!removed) throw new Error('brokerage rule does not exist');
        await audit(db, tenantId, userId, 'brokerage', 'deleted', { id });
      });
      res.json({ deleted: true });
    } catch (e) { next(e); }
  });

  r.get('/rate', async (req, res, next) => {
    try {
      const q = z.object({
        partyId: uuid, qualityId: uuid, kind: z.enum(['purchase', 'sales']),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
      }).parse(req.query);
      const { tenantId, userId } = req.session!;
      const resolved = await withTenant(tenantId, userId, db =>
        rateFor(db, q.partyId, q.qualityId, q.kind, q.date));
      if (!resolved) return res.status(404).json({ error: 'no valid rate contract matches this party, quality and date' });
      res.json(resolved);
    } catch (e) { next(e); }
  });

  r.post('/rates', requireWrite('owner'), async (req, res, next) => {
    try {
      const body = z.object({
        id: uuid.optional(), partyId: uuid, qualityId: uuid.nullable().default(null),
        kind: z.enum(['purchase', 'sales']), rate: amount,
        validFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        validTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null)
      }).refine(v => !v.validTo || v.validTo >= v.validFrom,
        { message: 'valid-to date cannot be before valid-from date', path: ['validTo'] }).parse(req.body);
      const { tenantId, userId } = req.session!;
      const saved = await withTenant(tenantId, userId, async db => {
        const row = body.id
          ? await one(db,
              `update rate_contract set party_id=$1, quality_id=$2, kind=$3,
                       rate=$4, valid_from=$5, valid_to=$6
                 where id=$7
               returning id, party_id, quality_id, kind, rate, valid_from, valid_to`,
              [body.partyId, body.qualityId, body.kind, body.rate,
               body.validFrom, body.validTo, body.id])
          : await one(db,
              `insert into rate_contract
                 (tenant_id, party_id, quality_id, kind, rate, valid_from, valid_to)
               values ($1,$2,$3,$4,$5,$6,$7)
               returning id, party_id, quality_id, kind, rate, valid_from, valid_to`,
              [tenantId, body.partyId, body.qualityId, body.kind, body.rate,
               body.validFrom, body.validTo]);
        if (!row) throw new Error('rate contract does not exist');
        await audit(db, tenantId, userId, 'rate_contract', body.id ? 'updated' : 'created', body);
        return row;
      });
      res.json(saved);
    } catch (e) { next(e); }
  });

  r.delete('/rates/:id', requireWrite('owner'), async (req, res, next) => {
    try {
      const id = uuid.parse(req.params.id);
      const { tenantId, userId } = req.session!;
      await withTenant(tenantId, userId, async db => {
        const removed = await one(db, 'delete from rate_contract where id=$1 returning id', [id]);
        if (!removed) throw new Error('rate contract does not exist');
        await audit(db, tenantId, userId, 'rate_contract', 'deleted', { id });
      });
      res.json({ deleted: true });
    } catch (e) { next(e); }
  });

  r.post('/tds-sections', requireWrite('owner'), async (req, res, next) => {
    try {
      const body = z.object({
        code: z.string().min(1).max(20).regex(/^[A-Z0-9()]+$/),
        kind: z.enum(['tds', 'tcs']), description: z.string().min(1).max(160),
        rate: amount.max(100), rateNoPan: amount.max(100), threshold: amount,
        basis: z.enum(['excess_over_threshold', 'full_once_crossed']),
        appliesTo: z.enum(['purchase', 'sales'])
      }).refine(v => v.rateNoPan >= v.rate, 'no-PAN rate must not be lower').parse(req.body);
      const { tenantId, userId } = req.session!;
      const row = await withTenant(tenantId, userId, async db => {
        const saved = await one(db,
          `insert into tax_deduction_section
             (tenant_id, code, kind, description, rate, rate_no_pan, threshold, basis, applies_to)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           on conflict (tenant_id, code) do update set
             kind=excluded.kind, description=excluded.description, rate=excluded.rate,
             rate_no_pan=excluded.rate_no_pan, threshold=excluded.threshold,
             basis=excluded.basis, applies_to=excluded.applies_to
           returning code, kind, description, rate, rate_no_pan, threshold, basis, applies_to`,
          [tenantId, body.code, body.kind, body.description, body.rate,
           body.rateNoPan, body.threshold, body.basis, body.appliesTo]);
        await audit(db, tenantId, userId, 'tds', 'section_saved', body);
        return saved;
      });
      res.json(row);
    } catch (e) { next(e); }
  });

  r.post('/ledger-tds', requireWrite('owner'), async (req, res, next) => {
    try {
      const body = z.object({ ledgerId: uuid, sectionCode: z.string().max(20).nullable() }).parse(req.body);
      const { tenantId, userId } = req.session!;
      const row = await withTenant(tenantId, userId, async db => {
        const saved = await one(db,
          `update ledger_account
              set tds_section=$1, auto_tds_tcs=($1 is not null), updated_at=now()
            where id=$2 returning id, name, tds_section`,
          [body.sectionCode, body.ledgerId]);
        if (!saved) throw new Error('ledger does not exist');
        await audit(db, tenantId, userId, 'tds', 'ledger_section_changed', body);
        return saved;
      });
      res.json(row);
    } catch (e) { next(e); }
  });

  return r;
}
