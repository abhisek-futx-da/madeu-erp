import { Router } from 'express';
import { z } from 'zod';
import { many, one, withTenant, nextDocNumber } from './db.ts';
import { requireWrite } from './auth.ts';
import {
  postDispatch, postDyeingIssue, postDyeingReceipt, postGreyInward, type Ctx
} from './domain.ts';
import { postLotReceipt } from './lot-receipt.ts';
import { raiseInvoiceForDispatch } from './invoicing.ts';
import { recordPurchaseInvoice, raiseNote } from './purchasing.ts';
import { submitInvoiceToIrp } from './irp-service.ts';
import { listQuery, paged, sendCsv, type ListSpec } from './listing.ts';
import { amountInWords } from './money.ts';
import { rateFor } from './config.ts';
import { postReprocessIssue, postReprocessReceipt } from './reprocess.ts';

const uuid = z.string().uuid();
const money = z.coerce.number().finite();
const qty = z.coerce.number().finite().nonnegative();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
const barcode = z.string().trim().min(1).max(40);
const MAX_DOC_LINES = 1000;

function fyLabel(d = new Date()) {
  const y = d.getFullYear();
  const start = d.getMonth() >= 3 ? y : y - 1;
  return `${start}-${String(start + 1).slice(2)}`;
}

export function documentRouter() {
  const router = Router();

  const withCtx = <T>(req: any, fn: (ctx: Ctx) => Promise<T>) => {
    const { tenantId, userId, activeLocationId } = req.session!;
    return withTenant(tenantId, userId, db => fn({
      db, tenantId, userId, activeLocationId, fy: fyLabel()
    }));
  };

  const listRoute = (path: string, name: string, spec: ListSpec) =>
    router.get(path, async (req, res, next) => {
      try {
        const q = listQuery.parse(req.query);
        const { tenantId, userId } = req.session!;
        const forExport = q.format === 'csv' ? { ...q, limit: 5000, offset: 0 } : q;
        const page = await withTenant(tenantId, userId, db =>
          paged<Record<string, unknown>>(db, spec, forExport));
        if (q.format === 'csv') return sendCsv(res, name, page.rows);
        res.json(page);
      } catch (e) { next(e); }
    });

  router.post('/grey-purchase-orders', requireWrite('purchase'), async (req, res, next) => {
    try {
      const body = z.object({
        partyId: uuid,
        orderDate: isoDate,
        shipToId: uuid.nullish(),
        brokerId: uuid.nullish(),
        transportId: uuid.nullish(),
        deliveryDays: z.coerce.number().int().min(0).default(0),
        deliveryDate: isoDate.nullish(),
        paymentTerms: z.string().max(200).default(''),
        remarks: z.string().max(500).default(''),
        lines: z.array(z.object({
          qualityId: uuid,
          designId: uuid.nullish(),
          gradeCode: z.string().min(1).max(20),
          pcs: z.coerce.number().int().positive(),
          cutLength: qty,
          qty: qty.refine(n => n > 0, 'qty must be positive'),
          rate: money.nonnegative().optional()
        })).min(1).max(MAX_DOC_LINES)
      }).parse(req.body);

      const out = await withCtx(req, async ctx => {
        const resolvedLines: Array<(typeof body.lines)[number] & { rate: number }> = [];
        for (const line of body.lines) {
          if (line.rate !== undefined) {
            resolvedLines.push({ ...line, rate: line.rate });
            continue;
          }
          const contract = await rateFor(ctx.db, body.partyId, line.qualityId, 'purchase', body.orderDate);
          if (!contract) throw new Error('no purchase rate is entered and no valid rate contract matches one order line');
          resolvedLines.push({ ...line, rate: contract.rate });
        }
        const orderNo = await nextDocNumber(ctx.db, ctx.tenantId, 'grey_po', ctx.fy);
        const order = await one<{ id: string }>(ctx.db,
          `insert into grey_purchase_order (tenant_id, order_no, order_date, party_id, ship_to_id,
             broker_id, transport_id, delivery_days, delivery_date, payment_terms, remarks,
             status, created_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'approved',$12) returning id`,
          [ctx.tenantId, orderNo, body.orderDate, body.partyId, body.shipToId ?? null,
           body.brokerId ?? null, body.transportId ?? null, body.deliveryDays,
           body.deliveryDate ?? null, body.paymentTerms, body.remarks, ctx.userId]);
        if (!order) throw new Error('order insert returned nothing');

        await ctx.db.query(
          `insert into grey_purchase_order_line (tenant_id, order_id, sno, quality_id, design_id,
             grade_code, pcs, cut_length, qty, rate)
           select $1, $2, x.sno, x.quality_id, x.design_id, x.grade_code, x.pcs, x.cut_length, x.qty, x.rate
             from unnest($3::smallint[], $4::uuid[], $5::uuid[], $6::text[], $7::int[],
                         $8::numeric[], $9::numeric[], $10::numeric[])
                  as x(sno, quality_id, design_id, grade_code, pcs, cut_length, qty, rate)`,
          [ctx.tenantId, order.id,
           resolvedLines.map((_, i) => i + 1),
           resolvedLines.map(l => l.qualityId),
           resolvedLines.map(l => l.designId ?? null),
           resolvedLines.map(l => l.gradeCode),
           resolvedLines.map(l => l.pcs),
           resolvedLines.map(l => l.cutLength),
           resolvedLines.map(l => l.qty),
           resolvedLines.map(l => l.rate)]);

        return { id: order.id, orderNo };
      });
      res.status(201).json(out);
    } catch (e) { next(e); }
  });

  /** Header page first, then all its lines in one more statement — never per order. */
  const orderListRoute = (
    path: string, name: string, spec: ListSpec,
    lineSql: string
  ) => router.get(path, async (req, res, next) => {
    try {
      const q = listQuery.parse(req.query);
      const { tenantId, userId } = req.session!;
      const forExport = q.format === 'csv' ? { ...q, limit: 5000, offset: 0 } : q;
      const data = await withTenant(tenantId, userId, async db => {
        const page = await paged<any>(db, spec, forExport);
        if (page.rows.length === 0) return page;
        const lines = await many<any>(db, lineSql, [page.rows.map(o => o.id)]);
        const byOrder = new Map<string, any[]>();
        for (const l of lines) {
          const bucket = byOrder.get(l.order_id);
          if (bucket) bucket.push(l); else byOrder.set(l.order_id, [l]);
        }
        return { ...page, rows: page.rows.map(o => ({ ...o, lines: byOrder.get(o.id) ?? [] })) };
      });
      if (q.format === 'csv') {
        return sendCsv(res, name, data.rows.map(({ lines, ...head }: any) => head));
      }
      res.json(data);
    } catch (e) { next(e); }
  });

  orderListRoute('/grey-purchase-orders', 'grey-purchase-orders', {
    from: `grey_purchase_order o
             join ledger_account l on l.id = o.party_id
             left join ledger_account b on b.id = o.broker_id
             left join ledger_account tr on tr.id = o.transport_id`,
    select: `o.id, o.order_no, o.order_date, o.status, o.delivery_date,
             o.delivery_days, o.payment_terms, o.remarks,
             l.name as party_name, l.gstin as party_gstin,
             b.name as broker_name, tr.name as transport_name`,
    search: ['o.order_no', 'l.name', 'o.remarks'],
    dateColumn: 'o.order_date',
    orderBy: 'o.order_date desc, o.order_no desc'
  }, `select ol.id, ol.order_id, ol.sno, ol.pcs, ol.qty, ol.rate, ol.amount, ol.received_qty,
             q.name as quality, d.name as design, ol.grade_code
        from grey_purchase_order_line ol
        join quality q on q.id = ol.quality_id
        left join design d on d.id = ol.design_id
       where ol.order_id = any($1::uuid[]) order by ol.sno`);

  router.get('/grey-purchase-orders/:id/print', async (req, res, next) => {
    try {
      const id = uuid.parse(req.params.id);
      const { tenantId, userId } = req.session!;
      const out = await withTenant(tenantId, userId, async db => {
        const head = await one<any>(db,
          `select o.order_no, o.order_date, o.delivery_date, o.delivery_days,
                  o.payment_terms, o.delivery_terms, o.remarks, o.status,
                  t.legal_name as buyer_name, t.gstin as buyer_gstin,
                  t.address1 as buyer_address, t.address2 as buyer_address2,
                  t.city as buyer_city, t.pincode as buyer_pincode,
                  p.name as supplier_name, p.gstin as supplier_gstin,
                  a.line1 as supplier_address, a.city as supplier_city,
                  a.pincode as supplier_pincode, a.state_code as supplier_state,
                  b.name as broker_name, tr.name as transport_name
             from grey_purchase_order o
             join tenant t on t.id = o.tenant_id
             join ledger_account p on p.id = o.party_id
             left join ledger_account b on b.id = o.broker_id
             left join ledger_account tr on tr.id = o.transport_id
             left join lateral (
               select line1, city, pincode, state_code from ledger_address
                where ledger_id = p.id order by is_primary desc, is_ship_to desc limit 1
             ) a on true
            where o.id = $1`, [id]);
        if (!head) return null;
        const lines = await many<any>(db,
          `select ol.sno, q.name as quality, q.construction, q.hsn_code,
                  d.name as design, ol.grade_code, ol.pcs, ol.cut_length,
                  ol.qty, ol.rate, ol.amount, ol.received_qty
             from grey_purchase_order_line ol
             join quality q on q.id = ol.quality_id
             left join design d on d.id = ol.design_id
            where ol.order_id = $1 order by ol.sno`, [id]);
        const total = lines.reduce((sum, line) => sum + Number(line.amount), 0);
        return { ...head, lines, total, amount_in_words: amountInWords(total) };
      });
      if (!out) return res.status(404).json({ error: 'purchase order not found' });
      res.json(out);
    } catch (e) { next(e); }
  });

  router.post('/dyeing-reprocesses', requireWrite('store'), async (req, res, next) => {
    try {
      const body = z.object({
        processHouseId: uuid,
        issueDate: isoDate,
        challanNo: z.string().trim().min(1).max(50),
        challanDate: isoDate,
        reason: z.string().trim().min(3).max(300),
        barcodes: z.array(barcode).min(1).max(MAX_DOC_LINES)
      }).parse(req.body);
      res.status(201).json(await withCtx(req, ctx => postReprocessIssue(ctx, body)));
    } catch (e) { next(e); }
  });

  orderListRoute('/dyeing-reprocesses', 'dyeing-reprocesses', {
    from: 'dyeing_reprocess rp join ledger_account ph on ph.id = rp.process_house_id',
    select: `rp.id, rp.issue_no, rp.issue_date, rp.challan_no, rp.challan_date,
             rp.reason, rp.status, rp.process_house_id, ph.name as process_house`,
    search: ['rp.issue_no', 'rp.challan_no', 'rp.reason', 'ph.name'],
    dateColumn: 'rp.issue_date',
    orderBy: 'rp.issue_date desc, rp.issue_no desc'
  }, `select rl.reprocess_id as order_id, rl.id, rl.sno, rl.issued_qty,rl.issued_weight_kg,
             rl.original_grade, p.barcode, p.status::text, q.name as quality,
             active.receipt_no, active.receipt_status, active.received_qty,active.received_weight_kg,
             active.additional_rate, active.finish_grade
        from dyeing_reprocess_line rl
        join piece p on p.id = rl.piece_id
        join quality q on q.id = p.quality_id
        left join lateral (
          select rr.receipt_no, rr.status::text as receipt_status,
                 rrl.received_qty,rrl.received_weight_kg,rrl.additional_rate,rrl.finish_grade
            from dyeing_reprocess_receipt_line rrl
            join dyeing_reprocess_receipt rr on rr.id = rrl.receipt_id
           where rrl.reprocess_line_id = rl.id and rr.status not in ('rejected','cancelled')
           order by rr.created_at desc limit 1
        ) active on true
       where rl.reprocess_id = any($1::uuid[]) order by rl.sno`);

  router.post('/dyeing-reprocess-receipts', requireWrite('store'), async (req, res, next) => {
    try {
      const body = z.object({
        reprocessId: uuid,
        receiptDate: isoDate,
        challanNo: z.string().trim().min(1).max(50),
        challanDate: isoDate,
        remarks: z.string().max(500).default(''),
        lines: z.array(z.object({
          barcode,
          receivedQty: qty.positive(),
          receivedWeightKg: qty.nullish(),
          additionalRate: money.nonnegative(),
          finishGrade: z.string().min(1).max(20)
        })).min(1).max(MAX_DOC_LINES)
      }).parse(req.body);
      res.status(201).json(await withCtx(req, ctx => postReprocessReceipt(ctx, body)));
    } catch (e) { next(e); }
  });

  router.get('/dyeing-reprocesses/:id/print', async (req, res, next) => {
    try {
      const id = uuid.parse(req.params.id);
      const { tenantId, userId } = req.session!;
      const out = await withTenant(tenantId, userId, async db => {
        const head = await one<any>(db,
          `select rp.issue_no, rp.issue_date, rp.challan_no, rp.challan_date,
                  rp.reason, rp.status, t.legal_name as mill_name, t.gstin as mill_gstin,
                  t.address1 as mill_address, t.city as mill_city, t.pincode as mill_pincode,
                  ph.name as process_house, ph.gstin as process_house_gstin,
                  a.line1 as process_address, a.city as process_city, a.pincode as process_pincode
             from dyeing_reprocess rp
             join tenant t on t.id = rp.tenant_id
             join ledger_account ph on ph.id = rp.process_house_id
             left join lateral (
               select line1, city, pincode from ledger_address
                where ledger_id = ph.id order by is_primary desc limit 1
             ) a on true
            where rp.id = $1`, [id]);
        if (!head) return null;
        const lines = await many<any>(db,
          `select rl.sno, p.barcode, q.name as quality, q.hsn_code,
                  rl.original_grade, rl.issued_qty, p.uom
             from dyeing_reprocess_line rl
             join piece p on p.id = rl.piece_id
             join quality q on q.id = p.quality_id
            where rl.reprocess_id = $1 order by rl.sno`, [id]);
        return { ...head, lines, pieces: lines.length,
          total_qty: lines.reduce((sum, line) => sum + Number(line.issued_qty), 0) };
      });
      if (!out) return res.status(404).json({ error: 'reprocess challan not found' });
      res.json(out);
    } catch (e) { next(e); }
  });

  router.post('/grey-inwards', requireWrite('store'), async (req, res, next) => {
    try {
      const body = z.object({
        partyId: uuid,
        entryDate: isoDate,
        challanNo: z.string().min(1).max(50),
        challanDate: isoDate,
        lotNo: z.string().max(50).default(''),
        transportId: uuid.nullish(),
        brokerId: uuid.nullish(),
        lrNo: z.string().max(50).nullish(),
        directIssue: z.boolean().default(false),
        remarks: z.string().max(500).default(''),
        rackCode: z.string().max(20).nullish(),
        lines: z.array(z.object({
          poLineId: uuid.nullish(),
          qualityId: uuid,
          designId: uuid.nullish(),
          gradeCode: z.string().min(1).max(20),
          barcode: z.string().min(4).max(40),
          lotNo: z.string().max(50).default(''),
          receivedQty: qty,
          checkedQty: qty,
          rate: money.nonnegative(),
          rateUom: z.enum(['MTR','KGS']).default('MTR'),
          grossWeightKg: qty.nullish(),
          tareWeightKg: qty.nullish(),
          netWeightKg: qty.nullish(),
          rackCode: z.string().max(20).nullish()
        })).min(1).max(MAX_DOC_LINES)
      }).parse(req.body);
      const out = await withCtx(req, ctx => postGreyInward(ctx, body, body.lines));
      res.status(201).json(out);
    } catch (e) { next(e); }
  });

  router.post('/dyeing-issues', requireWrite('store'), async (req, res, next) => {
    try {
      const body = z.object({
        processHouseId: uuid,
        weaverId: uuid.nullish(),
        entryDate: isoDate,
        challanNo: z.string().min(1).max(50),
        challanDate: isoDate,
        lotNo: z.string().max(50).default(''),
        noOfBales: z.coerce.number().int().min(0).optional(),
        vehicleNo: z.string().max(30).nullish(),
        remarks: z.string().max(500).default(''),
        jobRate: money.nonnegative().default(0),
        barcodes: z.array(z.string().min(4).max(40)).min(1).max(MAX_DOC_LINES)
      }).parse(req.body);
      const out = await withCtx(req, ctx => postDyeingIssue(ctx, body, body.barcodes, body.jobRate));
      res.status(201).json(out);
    } catch (e) { next(e); }
  });

  router.post('/dyeing-receipts', requireWrite('store'), async (req, res, next) => {
    try {
      const body = z.object({
        processHouseId: uuid,
        entryDate: isoDate,
        challanNo: z.string().min(1).max(50),
        challanDate: isoDate,
        remarks: z.string().max(500).default(''),
        lines: z.array(z.object({
          barcode: z.string().min(4).max(40),
          receivedQty: qty,
          receivedWeightKg: qty.nullish(),
          finishGrade: z.string().min(1).max(20),
          jobRate: money.nonnegative().default(0)
        })).min(1).max(MAX_DOC_LINES)
      }).parse(req.body);
      const out = await withCtx(req, ctx => postDyeingReceipt(ctx, body, body.lines));
      res.status(201).json(out);
    } catch (e) { next(e); }
  });

  /**
   * For a process house that cannot return the barcodes it was sent. The
   * quantities are agreed against the issue, and the finished thaans are new
   * pieces barcoded at the inspection table.
   */
  router.post('/dyeing-receipts/by-lot', requireWrite('store'), async (req, res, next) => {
    try {
      const body = z.object({
        issueId: uuid,
        entryDate: isoDate,
        challanNo: z.string().min(1).max(50),
        challanDate: isoDate,
        jobRate: money.nonnegative().default(0),
        remarks: z.string().max(500).default(''),
        pieces: z.array(z.object({
          barcode: z.string().min(4).max(40),
          qty: qty.refine(n => n > 0, 'every finished piece needs a length'),
          weightKg: qty.nullish(),
          finishGrade: z.string().min(1).max(20),
          rackCode: z.string().max(20).nullish()
        })).min(1).max(MAX_DOC_LINES)
      }).parse(req.body);
      const out = await withCtx(req, ctx => postLotReceipt(ctx, body, body.pieces));
      res.status(201).json(out);
    } catch (e) { next(e); }
  });

  /** What is still out at a process house, so a lot receipt can name its issue. */
  router.get('/dyeing-issues/outstanding', async (req, res, next) => {
    try {
      const q = z.object({ processHouseId: uuid.optional() }).parse(req.query);
      const { tenantId, userId } = req.session!;
      const rows = await withTenant(tenantId, userId, db => many(db,
        `select di.id as issue_id, di.entry_no, di.entry_date, di.challan_no, di.lot_no,
                l.name as process_house, di.process_house_id,
                count(*)::int as thaans, sum(il.issued_qty) as issued_qty,
                min(di.entry_date) as sent_on,
                current_date - di.entry_date as days_out
           from dyeing_issue di
           join dyeing_issue_line il on il.issue_id = di.id
           join piece p on p.id = il.piece_id
           join ledger_account l on l.id = di.process_house_id
          where is_live(di.status)
            and p.status in ('issued_to_dyeing','reprocess_at_process_house')
            and not exists (select 1 from dyeing_receipt_line rl
                             where rl.issue_line_id = il.id and rl.active)
            and ($1::uuid is null or di.process_house_id = $1)
          group by di.id, di.entry_no, di.entry_date, di.challan_no, di.lot_no,
                   l.name, di.process_house_id
          order by di.entry_date, di.entry_no`,
        [q.processHouseId ?? null]));
      res.json(rows);
    } catch (e) { next(e); }
  });

  router.post('/dispatches', requireWrite('sales'), async (req, res, next) => {
    try {
      const body = z.object({
        partyId: uuid,
        challanNo: z.string().min(1).max(50),
        challanDate: isoDate,
        transportId: uuid.nullish(),
        lrNo: z.string().max(50).nullish(),
        vehicleNo: z.string().max(30).nullish(),
        lines: z.array(z.object({
          barcode: z.string().min(4).max(40),
          rate: money.nonnegative(),
          soLineId: uuid.nullish(),
          // Which bale this thaan was strapped into; it is what the customer
          // reads when they cut the strap open.
          baleNo: z.coerce.number().int().min(1).max(9999).nullish()
        })).min(1).max(MAX_DOC_LINES)
      }).parse(req.body);
      const out = await withCtx(req, ctx => postDispatch(ctx, body, body.lines));
      res.status(201).json(out);
    } catch (e) { next(e); }
  });

  router.get('/dispatches', async (req, res, next) => {
    try {
      const q = listQuery.extend({ uninvoiced: z.coerce.boolean().optional() }).parse(req.query);
      const { tenantId, userId } = req.session!;
      const forExport = q.format === 'csv' ? { ...q, limit: 5000, offset: 0 } : q;
      const page = await withTenant(tenantId, userId, db =>
        paged<Record<string, unknown>>(db, {
        from: `(select d.id, d.challan_no, d.challan_date, l.name as party_name,
                       count(dl.id)::int as pieces,
                       coalesce(sum(dl.qty * dl.rate), 0) as value,
                       exists (select 1 from sales_invoice si
                                where si.dispatch_id = d.id and si.status <> 'cancelled')
                         as invoiced
                  from dispatch d
                  join ledger_account l on l.id = d.party_id
                  left join dispatch_line dl on dl.dispatch_id = d.id
                 where d.status <> 'cancelled'
                 group by d.id, d.challan_no, d.challan_date, l.name) d`,
        select: 'id, challan_no, challan_date, party_name, pieces, value, invoiced',
        search: ['challan_no', 'party_name'],
        dateColumn: 'challan_date',
        orderBy: 'challan_date desc, challan_no desc',
        where: q.uninvoiced ? 'not invoiced' : undefined
      }, forExport));
      if (q.format === 'csv') return sendCsv(res, 'dispatches', page.rows);
      res.json(page);
    } catch (e) { next(e); }
  });

  /**
   * A customer dispatch and its packing list are one physical truth.  The list
   * is rendered from the immutable dispatch lines, so a user cannot print a
   * second set of quantities that disagrees with stock or the later invoice.
   */
  router.get('/dispatches/:id/packing-list', async (req, res, next) => {
    try {
      const id = uuid.parse(req.params.id);
      const { tenantId, userId } = req.session!;
      const out = await withTenant(tenantId, userId, async db => {
        const head = await one<any>(db,
          `select d.challan_no, d.challan_date, d.lr_no, d.lr_date, d.vehicle_no,
                  d.status, t.legal_name as consignor_name, t.gstin as consignor_gstin,
                  t.address1 as consignor_address, t.address2 as consignor_address2,
                  t.city as consignor_city, t.pincode as consignor_pincode,
                  p.name as customer_name, p.gstin as customer_gstin,
                  coalesce(ship.name, p.name) as delivery_name,
                  coalesce(ship.gstin, p.gstin) as delivery_gstin,
                  a.line1 as delivery_address, a.city as delivery_city,
                  a.pincode as delivery_pincode, a.state_code as delivery_state,
                  tr.name as transport_name, tr.gstin as transporter_gstin
             from dispatch d
             join tenant t on t.id = d.tenant_id
             join ledger_account p on p.id = d.party_id
             left join ledger_account ship on ship.id = d.ship_to_id
             left join ledger_account tr on tr.id = d.transport_id
             left join lateral (
               select line1, city, pincode, state_code from ledger_address
                where ledger_id = coalesce(d.ship_to_id, d.party_id)
                order by is_ship_to desc, is_primary desc limit 1
             ) a on true
            where d.id = $1`, [id]);
        if (!head) return null;
        const lines = await many<any>(db,
          // The customer's own name for the cloth wins where they have given us
          // one: a packing list that reads in our vocabulary makes their
          // storekeeper reconcile it by hand.
          `select dl.sno, dl.bale_no, p.barcode, p.lot_no, p.grade_code, p.uom,
                  q.name as quality, q.construction, q.hsn_code,
                  des.name as design, dl.qty, dl.rate, (dl.qty * dl.rate) as value,
                  alias.their_quality, alias.their_design
             from dispatch_line dl
             join piece p on p.id = dl.piece_id
             join quality q on q.id = p.quality_id
             left join design des on des.id = p.design_id
             left join lateral party_item_name(
               (select party_id from dispatch where id = dl.dispatch_id),
               p.quality_id, p.design_id
             ) alias on true
            where dl.dispatch_id = $1 order by dl.sno`, [id]);
        return {
          ...head,
          lines,
          pieces: lines.length,
          total_qty: lines.reduce((sum, line) => sum + Number(line.qty), 0),
          total_value: lines.reduce((sum, line) => sum + Number(line.value), 0)
        };
      });
      if (!out) return res.status(404).json({ error: 'dispatch not found' });
      res.json(out);
    } catch (e) { next(e); }
  });

  router.post('/sales-invoices', requireWrite('sales'), async (req, res, next) => {
    try {
      const body = z.object({
        dispatchId: uuid,
        invoiceDate: isoDate.optional(),
        placeOfSupply: z.string().regex(/^\d{1,2}$/).optional(),
        distanceKm: z.coerce.number().int().min(1).max(4000).optional()
      }).parse(req.body);
      const out = await withCtx(req, ctx => raiseInvoiceForDispatch(ctx, body.dispatchId, body));
      res.status(201).json(out);
    } catch (e) { next(e); }
  });

  listRoute('/sales-invoices', 'tax-invoices', {
    from: `sales_invoice i
             join ledger_account p on p.id = i.party_id
             left join ledger_account b on b.id = i.broker_id
             left join gst_document g on g.invoice_id = i.id
             left join eway_bill e on e.source_doc = 'sales_invoice' and e.source_id = i.id
                                  and e.status <> 'cancelled'`,
    select: `i.id, i.invoice_no, i.invoice_date, i.place_of_supply, i.supply_type,
             i.taxable_value, i.cgst_amount, i.sgst_amount, i.igst_amount,
             i.party_id, i.round_off, i.invoice_total, i.brokerage_amount, i.brokerage_state,
             i.status, p.name as party_name, p.gstin, b.name as broker_name,
             g.filing_status, g.irn, g.last_error, e.ewb_no, e.our_ref as ewb_ref`,
    search: ['i.invoice_no', 'p.name', 'p.gstin'],
    dateColumn: 'i.invoice_date',
    orderBy: 'i.invoice_date desc, i.created_at desc'
  });

  router.get('/sales-invoices/:id/print', async (req, res, next) => {
    try {
      const id = uuid.parse(req.params.id);
      const { tenantId, userId } = req.session!;
      const out = await withTenant(tenantId, userId, async db => {
        const head = await one<any>(db,
          `select i.invoice_no, i.invoice_date, i.place_of_supply, i.supply_type,
                  i.taxable_value, i.cgst_amount, i.sgst_amount, i.igst_amount,
                  i.round_off, i.invoice_total, p.name as party_name, p.gstin,
                  g.irn, a.line1 as party_address, a.city as party_city,
                  a.pincode as party_pincode, a.state_code as party_state
             from sales_invoice i
             join ledger_account p on p.id = i.party_id
             left join gst_document g on g.invoice_id = i.id
             left join lateral (
               select line1, city, pincode, state_code from ledger_address
                where ledger_id = p.id order by is_ship_to desc, is_primary desc limit 1
             ) a on true
            where i.id = $1`, [id]);
        if (!head) return null;
        const lines = await many<any>(db,
          `select sno, description, hsn_code, qty, uom, rate, taxable_value, gst_rate,
                  cgst_amount, sgst_amount, igst_amount, line_total
             from sales_invoice_line where invoice_id = $1 order by sno`, [id]);
        return { ...head, lines, amount_in_words: amountInWords(Number(head.invoice_total)) };
      });
      if (!out) return res.status(404).json({ error: 'invoice not found' });
      res.json(out);
    } catch (e) { next(e); }
  });

  router.get('/sales-invoices/:id/einvoice', async (req, res, next) => {
    try {
      const { tenantId, userId } = req.session!;
      const row = await withTenant(tenantId, userId, db =>
        one<{ payload: unknown; filing_status: string; last_error: string | null }>(
          db,
          'select payload, filing_status, last_error from gst_document where invoice_id = $1',
          [req.params.id]));
      if (!row) return res.status(404).json({ error: 'no e-invoice payload for that invoice' });
      res.json(row);
    } catch (e) { next(e); }
  });

  router.post('/purchase-invoices', requireWrite('accounts'), async (req, res, next) => {
    try {
      const body = z.object({
        partyId: uuid,
        supplierInvoiceNo: z.string().min(1).max(50),
        invoiceDate: isoDate,
        kind: z.enum(['grey', 'jobwork']).default('grey'),
        itcEligible: z.boolean().default(true),
        // The delivery this bill settles. Without it the bill is a fresh
        // purchase; with it, it clears what that receipt already accrued.
        sourceDoc: z.enum(['grey_inward', 'dyeing_receipt']).nullish(),
        sourceId: uuid.nullish(),
        lines: z.array(z.object({
          hsnCode: z.string().min(4).max(10),
          description: z.string().min(1).max(200),
          qty: qty.refine(n => n > 0, 'qty must be positive'),
          uom: z.string().max(10).default('MTR'),
          rate: money.nonnegative(),
          gstRate: z.coerce.number().min(0).max(28)
        })).min(1).max(MAX_DOC_LINES)
      }).parse(req.body);
      const out = await withCtx(req, ctx => recordPurchaseInvoice(ctx, body, body.lines));
      res.status(201).json(out);
    } catch (e) { next(e); }
  });

  listRoute('/purchase-invoices', 'purchase-invoices', {
    from: `purchase_invoice pi join ledger_account l on l.id = pi.party_id`,
    select: `pi.id, pi.our_ref, pi.supplier_invoice_no, pi.invoice_date, pi.supply_type,
             pi.is_rcm, pi.taxable_value, pi.cgst_amount, pi.sgst_amount, pi.igst_amount,
             pi.invoice_total, pi.itc_eligible, pi.status, l.name as party_name`,
    search: ['pi.our_ref', 'pi.supplier_invoice_no', 'l.name'],
    dateColumn: 'pi.invoice_date',
    orderBy: 'pi.invoice_date desc, pi.created_at desc'
  });

  router.post('/gst-notes', requireWrite('accounts'), async (req, res, next) => {
    try {
      const body = z.object({
        kind: z.enum(['credit', 'debit']),
        againstInvoiceId: uuid,
        noteDate: isoDate,
        reason: z.string().min(1).max(200),
        taxableValue: money.positive()
      }).parse(req.body);
      const out = await withCtx(req, ctx => raiseNote(ctx, body));
      res.status(201).json(out);
    } catch (e) { next(e); }
  });

  listRoute('/gst-notes', 'credit-debit-notes', {
    from: `gst_note n
             join sales_invoice si on si.id = n.against_invoice_id
             join ledger_account l on l.id = n.party_id`,
    select: `n.id, n.note_no, n.note_kind, n.note_date, n.reason, n.status,
             n.taxable_value, n.cgst_amount, n.sgst_amount, n.igst_amount, n.note_total,
             si.invoice_no as against_invoice, l.name as party_name`,
    search: ['n.note_no', 'si.invoice_no', 'l.name', 'n.reason'],
    dateColumn: 'n.note_date',
    orderBy: 'n.note_date desc, n.note_no desc'
  });

  router.post('/sales-invoices/:id/submit-irn', requireWrite('accounts'), async (req, res, next) => {
    try {
      const { tenantId, userId } = req.session!;
      const id = uuid.parse(req.params.id);
      const out = await submitInvoiceToIrp(tenantId, userId, id);
      res.status(out.ok ? 200 : 422).json(out);
    } catch (e) { next(e); }
  });

  return router;
}
