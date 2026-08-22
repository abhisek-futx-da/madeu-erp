import { Router } from 'express';
import { z } from 'zod';
import { many, one, withTenant, nextDocNumber } from './db.ts';
import { clearSessionCookieOptions, login, requireAuth, requireWrite, sessionCookieOptions, throttleKey, tooManyAttempts, noteFailure, clearAttempts, revokeToken, SESSION_COOKIE } from './auth.ts';
import { resourceRouter } from './resources.ts';
import { postDispatch, postDyeingIssue, postDyeingReceipt, postGreyInward, type Ctx } from './domain.ts';
import { raiseInvoiceForDispatch } from './invoicing.ts';
import { recordPurchaseInvoice, raiseNote } from './purchasing.ts';
import { submitInvoiceToIrp } from './irp-service.ts';
import { deductionFor, recordDeduction, closeFinancialYear, reopenFinancialYear } from './tds.ts';
import { postCutPack } from './domain.ts';
import { recordPayment, suggestAllocation, cancelPayment } from './payments.ts';
import { postGreyReturn, postDyeingReturn, applyGreyReturn, applyDyeingReturn, applyCustomerReturn, postCustomerReturn } from './returns.ts';
import { postWriteOff, applyWriteOff } from './writeoff.ts';
import { cancelDocument } from './cancellation.ts';
import { listQuery, paged, sendCsv, type ListSpec } from './listing.ts';
import { ewayForInvoice, ewayForChallan } from './ewaybill.ts';
import { amountInWords } from './money.ts';
import { approveDocument, rejectDocument } from './approvals.ts';
import { splitPiece, mergePieces, lineageOf } from './regroup.ts';
import {
  openCount, addScans, removeScan, exceptionsFor, submitCount, applyStockCount
} from './stockcount.ts';

const uuid = z.string().uuid();
const money = z.coerce.number().finite();
const qty = z.coerce.number().finite().nonnegative();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

/**
 * A real challan runs to a few hundred pieces. The cap keeps one request from
 * holding a transaction (and a chunk of memory) open indefinitely, and matches
 * the IRP's own 1000-line ceiling for invoices.
 */
const MAX_DOC_LINES = 1000;

/** Indian FY label for a date: 1 April to 31 March. */
export function fyLabel(d = new Date()) {
  const y = d.getFullYear();
  const start = d.getMonth() >= 3 ? y : y - 1;
  return `${start}-${String(start + 1).slice(2)}`;
}

export function buildRoutes() {
  const api = Router();

  api.post('/auth/login', async (req, res, next) => {
    try {
      const body = z.object({
        email: z.string().email(),
        password: z.string().min(1),
        tenantId: uuid.optional()
      }).parse(req.body);
      const key = throttleKey(body.email, req.ip ?? 'unknown');
      const waitFor = await tooManyAttempts(key);
      if (waitFor !== null) {
        res.setHeader('retry-after', String(waitFor));
        return res.status(429).json({
          error: `too many failed attempts; try again in ${waitFor} seconds`
        });
      }

      const result = await login(body.email, body.password, body.tenantId);
      if (!result) {
        await noteFailure(key);
        return res.status(401).json({ error: 'invalid credentials' });
      }
      await clearAttempts(key);
      // The browser receives an HttpOnly, same-site session.  The legacy token
      // response remains for API compatibility and the test harness; the Link
      // ERP web application deliberately never stores or sends it.
      res.cookie(SESSION_COOKIE, result.token, sessionCookieOptions());
      res.setHeader('cache-control', 'no-store');
      res.json(result);
    } catch (e) { next(e); }
  });

  api.use(requireAuth);

  api.post('/auth/logout', async (req, res, next) => {
    try {
      if (req.session?.jti) await revokeToken(req.session.jti);
      res.clearCookie(SESSION_COOKIE, clearSessionCookieOptions());
      res.setHeader('cache-control', 'no-store');
      res.json({ signedOut: true });
    } catch (e) { next(e); }
  });

  api.get('/me', async (req, res, next) => {
    try {
      const { tenantId, userId, role } = req.session!;
      const [tenant, user] = await withTenant(tenantId, userId, async db => Promise.all([
        one<{ legal_name: string; gstin: string; fy_start: string }>(
          db, 'select legal_name, gstin, fy_start from tenant where id = $1', [tenantId]),
        one<{ email: string; full_name: string }>(
          db, 'select email, full_name from app_user where id = $1', [userId])
      ]));
      res.json({
        userId, tenantId, role,
        user: user ? { email: user.email, fullName: user.full_name } : null,
        tenant: tenant
          ? { legalName: tenant.legal_name, gstin: tenant.gstin, fyLabel: fyLabel(new Date(tenant.fy_start)) }
          : null
      });
    } catch (e) { next(e); }
  });

  // ------------------------------------------------------------- documents --

  const withCtx = <T>(req: any, fn: (ctx: Ctx) => Promise<T>) => {
    const { tenantId, userId } = req.session!;
    return withTenant(tenantId, userId, db => fn({ db, tenantId, userId, fy: fyLabel() }));
  };

  /**
   * Every document list: searchable, date-filterable, paged, and exportable.
   * They were all `limit 200` with no way past it, which made a mill's 201st
   * dispatch unreachable.
   */
  const listRoute = (path: string, name: string, spec: ListSpec) =>
    api.get(path, async (req, res, next) => {
      try {
        const q = listQuery.parse(req.query);
        const { tenantId, userId } = req.session!;
        // A CSV is the whole result set, not the page the screen happens to show.
        const forExport = q.format === 'csv' ? { ...q, limit: 5000, offset: 0 } : q;
        const page = await withTenant(tenantId, userId, db =>
          paged<Record<string, unknown>>(db, spec, forExport));
        if (q.format === 'csv') return sendCsv(res, name, page.rows);
        res.json(page);
      } catch (e) { next(e); }
    });

  api.post('/grey-purchase-orders', requireWrite('purchase'), async (req, res, next) => {
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
          rate: money.nonnegative()
        })).min(1).max(MAX_DOC_LINES)
      }).parse(req.body);

      const out = await withCtx(req, async ctx => {
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
           body.lines.map((_, i) => i + 1),
           body.lines.map(l => l.qualityId),
           body.lines.map(l => l.designId ?? null),
           body.lines.map(l => l.gradeCode),
           body.lines.map(l => l.pcs),
           body.lines.map(l => l.cutLength),
           body.lines.map(l => l.qty),
           body.lines.map(l => l.rate)]);

        return { id: order.id, orderNo };
      });
      res.status(201).json(out);
    } catch (e) { next(e); }
  });

  /** Header page first, then all its lines in one more statement — never per order. */
  const orderListRoute = (
    path: string, name: string, spec: ListSpec,
    lineSql: string
  ) => api.get(path, async (req, res, next) => {
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
    from: 'grey_purchase_order o join ledger_account l on l.id = o.party_id',
    select: `o.id, o.order_no, o.order_date, o.status, o.delivery_date,
             l.name as party_name, o.remarks`,
    search: ['o.order_no', 'l.name', 'o.remarks'],
    dateColumn: 'o.order_date',
    orderBy: 'o.order_date desc, o.order_no desc'
  }, `select ol.order_id, ol.sno, ol.pcs, ol.qty, ol.rate, ol.amount, ol.received_qty,
             q.name as quality, d.name as design, ol.grade_code
        from grey_purchase_order_line ol
        join quality q on q.id = ol.quality_id
        left join design d on d.id = ol.design_id
       where ol.order_id = any($1::uuid[]) order by ol.sno`);

  api.post('/grey-inwards', requireWrite('store'), async (req, res, next) => {
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
          rackCode: z.string().max(20).nullish()
        })).min(1).max(MAX_DOC_LINES)
      }).parse(req.body);
      const out = await withCtx(req, ctx => postGreyInward(ctx, body, body.lines));
      res.status(201).json(out);
    } catch (e) { next(e); }
  });

  api.post('/dyeing-issues', requireWrite('store'), async (req, res, next) => {
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

  api.post('/dyeing-receipts', requireWrite('store'), async (req, res, next) => {
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
          finishGrade: z.string().min(1).max(20),
          jobRate: money.nonnegative().default(0)
        })).min(1).max(MAX_DOC_LINES)
      }).parse(req.body);
      const out = await withCtx(req, ctx => postDyeingReceipt(ctx, body, body.lines));
      res.status(201).json(out);
    } catch (e) { next(e); }
  });

  api.post('/dispatches', requireWrite('sales'), async (req, res, next) => {
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
          soLineId: uuid.nullish()
        })).min(1).max(MAX_DOC_LINES)
      }).parse(req.body);
      const out = await withCtx(req, ctx => postDispatch(ctx, body, body.lines));
      res.status(201).json(out);
    } catch (e) { next(e); }
  });

  api.get('/dispatches', async (req, res, next) => {
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

  api.post('/sales-invoices', requireWrite('sales'), async (req, res, next) => {
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
             left join gst_document g on g.invoice_id = i.id
             left join eway_bill e on e.source_doc = 'sales_invoice' and e.source_id = i.id
                                  and e.status <> 'cancelled'`,
    select: `i.id, i.invoice_no, i.invoice_date, i.place_of_supply, i.supply_type,
             i.taxable_value, i.cgst_amount, i.sgst_amount, i.igst_amount,
             i.party_id, i.round_off, i.invoice_total, i.status, p.name as party_name, p.gstin,
             g.filing_status, g.irn, g.last_error, e.ewb_no, e.our_ref as ewb_ref`,
    search: ['i.invoice_no', 'p.name', 'p.gstin'],
    dateColumn: 'i.invoice_date',
    orderBy: 'i.invoice_date desc, i.created_at desc'
  });

  api.get('/sales-invoices/:id/print', async (req, res, next) => {
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

  api.get('/sales-invoices/:id/einvoice', async (req, res, next) => {
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

  api.post('/purchase-invoices', requireWrite('accounts'), async (req, res, next) => {
    try {
      const body = z.object({
        partyId: uuid,
        supplierInvoiceNo: z.string().min(1).max(50),
        invoiceDate: isoDate,
        kind: z.enum(['grey', 'jobwork']).default('grey'),
        itcEligible: z.boolean().default(true),
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

  api.post('/gst-notes', requireWrite('accounts'), async (req, res, next) => {
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

  api.post('/sales-invoices/:id/submit-irn', requireWrite('accounts'), async (req, res, next) => {
    try {
      const { tenantId, userId } = req.session!;
      const id = uuid.parse(req.params.id);
      const out = await submitInvoiceToIrp(tenantId, userId, id);
      res.status(out.ok ? 200 : 422).json(out);
    } catch (e) { next(e); }
  });

  // ---------------------------------------------------------- sales orders --

  api.post('/sales-orders', requireWrite('sales'), async (req, res, next) => {
    try {
      const body = z.object({
        partyId: uuid,
        orderDate: isoDate,
        shipToId: uuid.nullish(),
        brokerId: uuid.nullish(),
        transportId: uuid.nullish(),
        destination: z.string().max(100).default(''),
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
          rate: money.nonnegative()
        })).min(1).max(MAX_DOC_LINES)
      }).parse(req.body);

      const out = await withCtx(req, async ctx => {
        const orderNo = await nextDocNumber(ctx.db, ctx.tenantId, 'sales_order', ctx.fy);
        const order = await one<{ id: string }>(ctx.db,
          `insert into finish_sales_order (tenant_id, order_no, order_date, party_id, ship_to_id,
             broker_id, transport_id, destination, delivery_days, delivery_date, payment_terms,
             remarks, status, created_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'approved',$13) returning id`,
          [ctx.tenantId, orderNo, body.orderDate, body.partyId, body.shipToId ?? null,
           body.brokerId ?? null, body.transportId ?? null, body.destination, body.deliveryDays,
           body.deliveryDate ?? null, body.paymentTerms, body.remarks, ctx.userId]);
        if (!order) throw new Error('sales order insert returned nothing');

        await ctx.db.query(
          `insert into finish_sales_order_line (tenant_id, order_id, sno, quality_id, design_id,
             grade_code, pcs, cut_length, qty, rate)
           select $1, $2, x.sno, x.quality_id, x.design_id, x.grade_code, x.pcs, x.cut_length,
                  x.qty, x.rate
             from unnest($3::smallint[], $4::uuid[], $5::uuid[], $6::text[], $7::int[],
                         $8::numeric[], $9::numeric[], $10::numeric[])
                  as x(sno, quality_id, design_id, grade_code, pcs, cut_length, qty, rate)`,
          [ctx.tenantId, order.id,
           body.lines.map((_, i) => i + 1),
           body.lines.map(l => l.qualityId),
           body.lines.map(l => l.designId ?? null),
           body.lines.map(l => l.gradeCode),
           body.lines.map(l => l.pcs),
           body.lines.map(l => l.cutLength),
           body.lines.map(l => l.qty),
           body.lines.map(l => l.rate)]);

        return { id: order.id, orderNo };
      });
      res.status(201).json(out);
    } catch (e) { next(e); }
  });

  orderListRoute('/sales-orders', 'sales-orders', {
    from: 'finish_sales_order o join ledger_account l on l.id = o.party_id',
    select: `o.id, o.order_no, o.order_date, o.status, o.delivery_date, o.destination,
             l.name as party_name`,
    search: ['o.order_no', 'l.name', 'o.destination'],
    dateColumn: 'o.order_date',
    orderBy: 'o.order_date desc, o.order_no desc'
  }, `select sl.order_id, sl.sno, sl.pcs, sl.qty, sl.rate, sl.amount, sl.dispatched_qty,
             q.name as quality, d.name as design, sl.grade_code
        from finish_sales_order_line sl
        join quality q on q.id = sl.quality_id
        left join design d on d.id = sl.design_id
       where sl.order_id = any($1::uuid[]) order by sl.sno`);

  api.post('/cut-pack', requireWrite('store'), async (req, res, next) => {
    try {
      const body = z.object({
        barcodes: z.array(z.string().min(4).max(40)).min(1).max(MAX_DOC_LINES),
        note: z.string().max(200).default('')
      }).parse(req.body);
      const out = await withCtx(req, ctx => postCutPack(ctx, body.barcodes, body.note));
      res.status(201).json(out);
    } catch (e) { next(e); }
  });

  // -------------------------------------------------------------- returns --

  api.post('/grey-returns', requireWrite('store'), async (req, res, next) => {
    try {
      const body = z.object({
        weaverId: uuid,
        entryDate: isoDate,
        challanNo: z.string().max(50),
        challanDate: isoDate.optional(),
        reason: z.string().min(1).max(200),
        lines: z.array(z.object({
          barcode: barcode,
          qty: qty.positive()
        })).min(1).max(MAX_DOC_LINES)
      }).parse(req.body);

      const out = await withCtx(req, ctx => postGreyReturn(ctx, body));
      res.status(201).json(out);
    } catch (e) { next(e); }
  });


  api.post('/dyeing-returns', requireWrite('store'), async (req, res, next) => {
    try {
      const body = z.object({
        processHouseId: uuid,
        entryDate: isoDate,
        challanNo: z.string().max(50),
        challanDate: isoDate.optional(),
        reason: z.string().min(1).max(200),
        lines: z.array(z.object({
          barcode: barcode,
          qty: qty.positive()
        })).min(1).max(MAX_DOC_LINES)
      }).parse(req.body);

      const out = await withCtx(req, ctx => postDyeingReturn(ctx, body));
      res.status(201).json(out);
    } catch (e) { next(e); }
  });

  // ------------------------------------------------------------- payments --

  const allocation = z.object({
    salesInvoiceId: uuid.nullish(),
    purchaseInvoiceId: uuid.nullish(),
    amount: money.positive()
  });

  api.post('/payments', requireWrite('accounts'), async (req, res, next) => {
    try {
      const body = z.object({
        kind: z.enum(['receipt', 'payment']),
        partyId: uuid,
        paymentDate: isoDate,
        mode: z.enum(['cash', 'cheque', 'neft', 'rtgs', 'upi', 'adjustment']),
        amount: money.positive(),
        discount: money.nonnegative().default(0),
        instrumentNo: z.string().max(40).nullish(),
        instrumentDate: isoDate.nullish(),
        bankLedgerId: uuid.nullish(),
        narration: z.string().max(300).default(''),
        allocations: z.array(allocation).max(MAX_DOC_LINES).default([])
      }).parse(req.body);
      const out = await withCtx(req, ctx => recordPayment(ctx, body));
      res.status(201).json(out);
    } catch (e) { next(e); }
  });

  listRoute('/payments', 'receipts-and-payments', {
    from: `payment p
             join ledger_account l on l.id = p.party_id
             left join ledger_account b on b.id = p.bank_ledger_id`,
    select: `p.id, p.voucher_no, p.kind, p.payment_date, p.mode, p.instrument_no,
             p.amount, p.discount, p.narration, p.status, p.reconciled_at,
             l.name as party_name, b.name as bank_name,
             coalesce((select sum(a.amount) from payment_allocation a
                        where a.payment_id = p.id), 0) as allocated`,
    search: ['p.voucher_no', 'l.name', 'p.instrument_no', 'p.narration'],
    dateColumn: 'p.payment_date',
    orderBy: 'p.payment_date desc, p.created_at desc'
  });

  api.post('/payments/suggest', async (req, res, next) => {
    try {
      const body = z.object({
        partyId: uuid,
        kind: z.enum(['receipt', 'payment']),
        amount: money.positive()
      }).parse(req.body);
      const out = await withCtx(req, ctx =>
        suggestAllocation(ctx, body.partyId, body.kind, body.amount));
      res.json(out);
    } catch (e) { next(e); }
  });

  api.post('/payments/:id/cancel', requireWrite('accounts'), async (req, res, next) => {
    try {
      const id = uuid.parse(req.params.id);
      const body = z.object({ reason: z.string().min(1).max(200) }).parse(req.body);
      const out = await withCtx(req, ctx => cancelPayment(ctx, id, body.reason));
      res.json(out);
    } catch (e) { next(e); }
  });

  // --------------------------------------------------------- cancellation --

  api.post('/documents/:kind/:id/cancel', requireWrite('accounts'), async (req, res, next) => {
    try {
      const kind = z.enum([
        'sales_invoice', 'purchase_invoice', 'dispatch', 'grey_inward',
        'dyeing_issue', 'dyeing_receipt', 'sales_order', 'grey_purchase_order',
        'piece_regroup', 'stock_count', 'grey_return', 'dyeing_return',
        'customer_return', 'write_off', 'gst_note'
      ]).parse(req.params.kind);
      const id = uuid.parse(req.params.id);
      const body = z.object({ reason: z.string().min(1).max(200) }).parse(req.body);
      const out = await withCtx(req, ctx => cancelDocument(ctx, kind, id, body.reason));
      res.json(out);
    } catch (e) { next(e); }
  });

  api.post('/customer-returns', requireWrite('sales'), async (req, res, next) => {
    try {
      const body = z.object({
        customerId: uuid,
        againstInvoiceId: uuid,
        entryDate: isoDate,
        challanNo: z.string().max(50).default(''),
        reason: z.string().min(1).max(200),
        lines: z.array(z.object({
          barcode: z.string().max(40),
          qty: z.coerce.number().positive()
        })).min(1)
      }).parse(req.body);

      const out = await withCtx(req, ctx => postCustomerReturn(ctx, body));
      res.status(201).json(out);
    } catch (e) { next(e); }
  });


  api.post('/write-offs', requireWrite('store'), async (req, res, next) => {
    try {
      const body = z.object({
        entryDate: isoDate,
        reason: z.string().min(1).max(200),
        lines: z.array(z.object({ barcode: barcode })).min(1).max(MAX_DOC_LINES)
      }).parse(req.body);
      res.status(201).json(await withCtx(req, ctx => postWriteOff(ctx, body)));
    } catch (e) { next(e); }
  });

  // --------------------------------------------------------- approvals --

  api.get('/approvals/pending', async (req, res, next) => {
    try {
      const { tenantId, userId } = req.session!;
      const rows = await withTenant(tenantId, userId, db =>
        many(db, 'select * from v_pending_approvals order by created_at'));
      res.json(rows);
    } catch (e) { next(e); }
  });

  api.get('/approvals/history', async (req, res, next) => {
    try {
      const q = z.object({
        limit: z.coerce.number().int().min(1).max(500).default(100)
      }).parse(req.query);
      const { tenantId, userId } = req.session!;
      const rows = await withTenant(tenantId, userId, db =>
        many(db, 'select * from v_approval_history limit $1', [q.limit]));
      res.json(rows);
    } catch (e) { next(e); }
  });

  const approvable = z.enum(['sales_invoice', 'purchase_invoice', 'payment', 'stock_count',
    'grey_return', 'dyeing_return', 'customer_return', 'write_off']);

  /** Approving is a write on the document's own area, plus the rule's role. */
  // Approvals check their own roles internally
  api.post('/approvals/:kind/:id/approve', async (req, res, next) => {
    try {
      const kind = approvable.parse(req.params.kind);
      const id = uuid.parse(req.params.id);
      const body = z.object({ note: z.string().max(300).default('') }).parse(req.body ?? {});
      const { tenantId, userId, role } = req.session!;
      const out = await withTenant(tenantId, userId, db =>
        approveDocument(
          { db, tenantId, userId, fy: fyLabel(), role }, kind, id, body.note,
          // A stock count moves pieces as well as rupees, and both happen in
          // this one transaction or neither does.
          kind === 'stock_count' ? ctx => applyStockCount(ctx, id).then(() => undefined)
            : kind === 'grey_return' ? ctx => applyGreyReturn(ctx, id)
            : kind === 'dyeing_return' ? ctx => applyDyeingReturn(ctx, id)
            : kind === 'customer_return' ? ctx => applyCustomerReturn(ctx, id).then(() => undefined)
            : kind === 'write_off' ? ctx => applyWriteOff(ctx, id)
            : undefined
        ));
      res.json(out);
    } catch (e) { next(e); }
  });

  api.post('/approvals/:kind/:id/reject', async (req, res, next) => {
    try {
      const kind = approvable.parse(req.params.kind);
      const id = uuid.parse(req.params.id);
      const body = z.object({ reason: z.string().min(1).max(300) }).parse(req.body);
      const { tenantId, userId, role } = req.session!;
      const out = await withTenant(tenantId, userId, db =>
        rejectDocument({ db, tenantId, userId, fy: fyLabel(), role }, kind, id, body.reason));
      res.json(out);
    } catch (e) { next(e); }
  });

  api.get('/approval-rules', async (req, res, next) => {
    try {
      const { tenantId, userId } = req.session!;
      const rows = await withTenant(tenantId, userId, db =>
        many(db, `select doc_type, min_amount, approver_role, is_active
                    from approval_rule order by doc_type`));
      res.json(rows);
    } catch (e) { next(e); }
  });

  /** Who has to sign off, and above what, is the owner's decision alone. */
  api.post('/approval-rules', requireWrite('owner'), async (req, res, next) => {
    try {
      if (req.session!.role !== 'owner') {
        return res.status(403).json({ error: 'only the owner sets approval limits' });
      }
      const body = z.object({
        docType: approvable,
        minAmount: money.nonnegative(),
        approverRole: z.enum(['owner', 'accounts', 'sales', 'purchase', 'store']),
        isActive: z.boolean().default(true)
      }).parse(req.body);
      const { tenantId, userId } = req.session!;
      const out = await withTenant(tenantId, userId, db =>
        one(db,
          `insert into approval_rule (tenant_id, doc_type, min_amount, approver_role, is_active)
           values ($1,$2,$3,$4,$5)
           on conflict (tenant_id, doc_type) do update
             set min_amount = excluded.min_amount,
                 approver_role = excluded.approver_role,
                 is_active = excluded.is_active
           returning doc_type, min_amount, approver_role, is_active`,
          [tenantId, body.docType, body.minAmount, body.approverRole, body.isActive]));
      res.status(201).json(out);
    } catch (e) { next(e); }
  });

  // ---------------------------------------------------------- tds / close --

  api.post('/tds/preview', async (req, res, next) => {
    try {
      const body = z.object({ partyId: uuid, amount: money.positive() }).parse(req.body);
      const out = await withCtx(req, ctx => deductionFor(ctx, body.partyId, body.amount));
      res.json(out ?? { applicable: false });
    } catch (e) { next(e); }
  });

  api.post('/tds/deduct', requireWrite('accounts'), async (req, res, next) => {
    try {
      const body = z.object({
        partyId: uuid, amount: money.positive(),
        docType: z.string().min(1).max(40), docId: uuid, docDate: isoDate
      }).parse(req.body);
      const out = await withCtx(req, async ctx => {
        const d = await deductionFor(ctx, body.partyId, body.amount);
        if (!d) return null;
        return recordDeduction(ctx, d, { id: body.partyId },
          { type: body.docType, id: body.docId, date: body.docDate });
      });
      if (!out) return res.json({ applicable: false });
      res.status(201).json(out);
    } catch (e) { next(e); }
  });

  api.get('/financial-years', async (req, res, next) => {
    try {
      const { tenantId, userId } = req.session!;
      const rows = await withTenant(tenantId, userId, db =>
        many(db, `select label, starts_on, ends_on, status, closed_at
                    from financial_year order by starts_on desc`));
      res.json(rows);
    } catch (e) { next(e); }
  });

  api.post('/financial-years/:label/close', requireWrite('accounts'), async (req, res, next) => {
    try {
      const label = z.string().regex(/^\d{4}-\d{2}$/).parse(req.params.label);
      const body = z.object({ nextLabel: z.string().regex(/^\d{4}-\d{2}$/) }).parse(req.body);
      const out = await withCtx(req, ctx => closeFinancialYear(ctx, label, body.nextLabel));
      res.json(out);
    } catch (e) { next(e); }
  });

  api.post('/financial-years/:label/reopen', requireWrite('accounts'), async (req, res, next) => {
    try {
      if (req.session!.role !== 'owner') {
        return res.status(403).json({ error: 'only the owner may reopen a closed year' });
      }
      const label = z.string().regex(/^\d{4}-\d{2}$/).parse(req.params.label);
      const body = z.object({ nextLabel: z.string().regex(/^\d{4}-\d{2}$/) }).parse(req.body);
      const out = await withCtx(req, ctx => reopenFinancialYear(ctx, label, body.nextLabel));
      res.json(out);
    } catch (e) { next(e); }
  });

  api.post('/gstr2b/import', requireWrite('accounts'), async (req, res, next) => {
    try {
      const body = z.object({
        returnPeriod: z.string().regex(/^\d{2}-\d{4}$/),
        lines: z.array(z.object({
          supplierGstin: z.string().length(15),
          supplierName: z.string().max(120).optional(),
          invoiceNo: z.string().min(1).max(50),
          invoiceDate: isoDate,
          taxableValue: money.nonnegative(),
          cgstAmount: money.nonnegative().default(0),
          sgstAmount: money.nonnegative().default(0),
          igstAmount: money.nonnegative().default(0)
        })).min(1).max(5000)
      }).parse(req.body);

      const { tenantId, userId } = req.session!;
      const inserted = await withTenant(tenantId, userId, async db => {
        const r = await db.query(
          `insert into gstr2b_line (tenant_id, return_period, supplier_gstin, supplier_name,
             invoice_no, invoice_date, taxable_value, cgst_amount, sgst_amount, igst_amount)
           select $1, $2, x.gstin, x.name, x.no, x.dt, x.taxable, x.cgst, x.sgst, x.igst
             from unnest($3::text[], $4::text[], $5::text[], $6::date[], $7::numeric[],
                         $8::numeric[], $9::numeric[], $10::numeric[])
                  as x(gstin, name, no, dt, taxable, cgst, sgst, igst)
           on conflict (tenant_id, return_period, supplier_gstin, invoice_no) do update
             set taxable_value = excluded.taxable_value,
                 cgst_amount = excluded.cgst_amount,
                 sgst_amount = excluded.sgst_amount,
                 igst_amount = excluded.igst_amount`,
          [tenantId, body.returnPeriod,
           body.lines.map(l => l.supplierGstin),
           body.lines.map(l => l.supplierName ?? null),
           body.lines.map(l => l.invoiceNo),
           body.lines.map(l => l.invoiceDate),
           body.lines.map(l => l.taxableValue),
           body.lines.map(l => l.cgstAmount),
           body.lines.map(l => l.sgstAmount),
           body.lines.map(l => l.igstAmount)]);
        return r.rowCount ?? 0;
      });
      res.status(201).json({ imported: inserted, returnPeriod: body.returnPeriod });
    } catch (e) { next(e); }
  });

  // --------------------------------------------------------------- lookups --

  api.get('/pieces', async (req, res, next) => {
    try {
      const q = z.object({
        // Comma-separated: dispatch draws from received_finish and cut_packed.
        status: z.string().max(120).optional(),
        barcode: z.string().max(40).optional(),
        lotNo: z.string().max(50).optional(),
        limit: z.coerce.number().int().min(1).max(100000).default(200)
      }).parse(req.query);
      const statuses = q.status ? q.status.split(',').map(s => s.trim()).filter(Boolean) : null;
      const { tenantId, userId } = req.session!;
      const rows = await withTenant(tenantId, userId, db =>
        many(db,
          `select p.id, p.barcode, p.status, p.lot_no, p.grade_code, p.uom, p.rack_code,
                  p.grey_qty, p.finish_qty, p.current_qty,
                  p.grey_cost + p.jobwork_cost + p.other_cost as cost,
                  q.name as quality, d.name as design, l.name as held_by
             from piece p
             join quality q on q.id = p.quality_id
             left join design d on d.id = p.design_id
             left join ledger_account l on l.id = p.held_by_ledger_id
            where ($1::text[] is null or p.status::text = any($1::text[]))
              and ($2::text is null or p.barcode = $2)
              and ($3::text is null or p.lot_no = $3)
            order by p.created_at desc limit $4`,
          [statuses, q.barcode ?? null, q.lotNo ?? null, q.limit]));
      res.json(rows);
    } catch (e) { next(e); }
  });

  // --------------------------------------------------------- split / merge --

  const barcode = z.string().trim().min(1).max(40);

  api.post('/pieces/:barcode/split', requireWrite('store'), async (req, res, next) => {
    try {
      const body = z.object({
        entryDate: isoDate,
        reason: z.string().max(200).default(''),
        lossQty: qty.nonnegative().default(0),
        children: z.array(z.object({ barcode: barcode.optional(), qty: qty.positive() }))
          .min(1).max(MAX_DOC_LINES)
      }).parse(req.body);
      const out = await withCtx(req, ctx =>
        splitPiece(ctx, { barcode: barcode.parse(req.params.barcode), ...body }));
      res.status(201).json(out);
    } catch (e) { next(e); }
  });

  api.post('/pieces/merge', requireWrite('store'), async (req, res, next) => {
    try {
      const body = z.object({
        barcodes: z.array(barcode).min(2).max(MAX_DOC_LINES),
        intoBarcode: barcode,
        entryDate: isoDate,
        reason: z.string().max(200).default('')
      }).parse(req.body);
      const out = await withCtx(req, ctx => mergePieces(ctx, body));
      res.status(201).json(out);
    } catch (e) { next(e); }
  });

  api.get('/pieces/:barcode/lineage', async (req, res, next) => {
    try {
      const out = await withCtx(req, ctx => lineageOf(ctx, req.params.barcode!));
      res.json(out);
    } catch (e) { next(e); }
  });

  listRoute('/piece-regroups', 'piece-regroups', {
    // Lateral rather than a group by: `paged` wraps the same FROM in a count,
    // and an aggregate there would count groups instead of rows.
    from: `piece_regroup r
             left join app_user u on u.id = r.created_by
             left join lateral (
               select count(*)::int as pieces, coalesce(sum(qty), 0) as qty
                 from piece_lineage where regroup_id = r.id
             ) l on true`,
    select: `r.id, r.entry_no, r.entry_date, r.kind::text as kind, r.reason,
             r.status::text as status, u.full_name as created_by, l.pieces, l.qty`,
    search: ['r.entry_no', 'r.reason'],
    dateColumn: 'r.entry_date',
    orderBy: 'r.entry_date desc, r.entry_no desc'
  });

  // ------------------------------------------------------------ stock count --

  const varianceKind = z.enum([
    'missing', 'extra', 'short', 'excess', 'wrong_rack', 'duplicate_scan'
  ]);
  const outcome = z.enum([
    'write_off', 'adjust_qty', 'relocate', 'accept_system', 'needs_inward', 'investigate'
  ]);

  api.post('/stock-counts', requireWrite('store'), async (req, res, next) => {
    try {
      const body = z.object({
        countDate: isoDate,
        rackCode: z.string().max(20).nullish(),
        qualityId: uuid.nullish(),
        lotNo: z.string().max(50).nullish(),
        reason: z.string().max(200).default('')
      }).parse(req.body);
      const out = await withCtx(req, ctx => openCount(ctx, body));
      res.status(201).json(out);
    } catch (e) { next(e); }
  });

  api.post('/stock-counts/:id/scans', requireWrite('store'), async (req, res, next) => {
    try {
      const id = uuid.parse(req.params.id);
      const body = z.object({
        scans: z.array(z.object({
          barcode: z.string().trim().min(1).max(40),
          rackCode: z.string().max(20).nullish(),
          qty: qty.nullish(),
          note: z.string().max(200).optional()
        })).min(1).max(MAX_DOC_LINES)
      }).parse(req.body);
      const out = await withCtx(req, ctx => addScans(ctx, id, body.scans));
      res.status(201).json(out);
    } catch (e) { next(e); }
  });

  api.delete('/stock-counts/:id/scans/:scanId', requireWrite('store'), async (req, res, next) => {
    try {
      const id = uuid.parse(req.params.id);
      const scanId = z.coerce.number().int().positive().parse(req.params.scanId);
      const out = await withCtx(req, ctx => removeScan(ctx, id, scanId));
      res.json(out);
    } catch (e) { next(e); }
  });

  api.get('/stock-counts/:id', async (req, res, next) => {
    try {
      const id = uuid.parse(req.params.id);
      const out = await withCtx(req, async ctx => ({
        count: await one(ctx.db, 'select * from v_stock_count_summary where count_id = $1', [id]),
        sheet: await many(ctx.db,
          'select * from v_stock_count_sheet where count_id = $1 order by rack_code, barcode', [id]),
        exceptions: await exceptionsFor(ctx, id),
        scans: await many(ctx.db,
          `select id, barcode, rack_code, qty, note, scanned_at
             from stock_count_scan where count_id = $1 order by id desc limit 500`, [id]),
        variances: await many(ctx.db,
          'select * from v_stock_count_variance where count_id = $1 order by kind, barcode', [id])
      }));
      if (!out.count) return res.status(404).json({ error: 'no such stock count' });
      res.json(out);
    } catch (e) { next(e); }
  });

  api.post('/stock-counts/:id/submit', requireWrite('store'), async (req, res, next) => {
    try {
      const id = uuid.parse(req.params.id);
      const body = z.object({
        decisions: z.array(z.object({
          barcode: z.string().trim().min(1).max(40),
          kind: varianceKind,
          outcome,
          reason: z.string().trim().min(1).max(200)
        })).max(5000)
      }).parse(req.body);
      const out = await withCtx(req, ctx => submitCount(ctx, id, body.decisions));
      res.json(out);
    } catch (e) { next(e); }
  });

  listRoute('/stock-counts', 'stock-counts', {
    from: `v_stock_count_summary s`,
    select: `s.count_id, s.count_no, s.count_date, s.status, s.rack_code, s.quality,
             s.lot_no, s.reason, s.pieces_expected, s.pieces_counted, s.variances,
             s.loss_value, s.gain_value, s.net_value, s.counted_by`,
    search: ['s.count_no', 's.reason', 's.rack_code'],
    dateColumn: 's.count_date',
    orderBy: 's.count_date desc, s.count_no desc'
  });

  api.get('/pieces/:barcode/history', async (req, res, next) => {
    try {
      const { tenantId, userId } = req.session!;
      const rows = await withTenant(tenantId, userId, db =>
        many(db, 'select * from v_barcode_history where barcode = $1 order by occurred_at',
          [req.params.barcode]));
      res.json(rows);
    } catch (e) { next(e); }
  });

  // ------------------------------------------------- dashboard & statements --

  api.get('/dashboard', async (req, res, next) => {
    try {
      const { tenantId, userId } = req.session!;
      const data = await withTenant(tenantId, userId, async db => {
        const [summary, trend, debtors] = await Promise.all([
          one<Record<string, number>>(db, 'select * from report_dashboard()'),
          many(db, 'select * from v_sales_trend'),
          many(db, 'select * from v_top_debtors limit 10')
        ]);
        return { summary, trend, topDebtors: debtors };
      });
      res.json(data);
    } catch (e) { next(e); }
  });

  const period = z.object({
    from: isoDate.optional(),
    to: isoDate.optional(),
    format: z.enum(['json', 'csv']).default('json')
  });

  api.get('/statements/profit-loss', async (req, res, next) => {
    try {
      const q = period.parse(req.query);
      const to = q.to ?? new Date().toISOString().slice(0, 10);
      const from = q.from ?? `${fyLabel(new Date(to)).slice(0, 4)}-04-01`;
      const { tenantId, userId } = req.session!;
      const rows = await withTenant(tenantId, userId, db =>
        many<{ section: string; amount: number }>(
          db, 'select * from report_profit_loss($1::date, $2::date)', [from, to]));
      if (q.format === 'csv') return sendCsv(res, `profit-loss-${from}-to-${to}`, rows);

      const total = (s: string) =>
        rows.filter(r => r.section === s).reduce((n, r) => n + Number(r.amount), 0);
      const income = total('income');
      const expense = total('expense');
      res.json({
        from, to, rows,
        totals: { income, expense, netProfit: Math.round((income - expense) * 100) / 100 }
      });
    } catch (e) { next(e); }
  });

  api.get('/statements/balance-sheet', async (req, res, next) => {
    try {
      const q = period.parse(req.query);
      const asOn = q.to ?? new Date().toISOString().slice(0, 10);
      const { tenantId, userId } = req.session!;
      const rows = await withTenant(tenantId, userId, db =>
        many<{ section: string; amount: number }>(
          db, 'select * from report_balance_sheet($1::date)', [asOn]));
      if (q.format === 'csv') return sendCsv(res, `balance-sheet-as-on-${asOn}`, rows);

      const total = (s: string) =>
        rows.filter(r => r.section === s).reduce((n, r) => n + Number(r.amount), 0);
      const assets = total('asset');
      const liabilities = total('liability');
      const equity = total('equity');
      res.json({
        asOn, rows,
        totals: {
          assets, liabilities, equity,
          // Zero on a healthy set of books; anything else is a posting defect.
          difference: Math.round((assets - liabilities - equity) * 100) / 100
        }
      });
    } catch (e) { next(e); }
  });

  // ----------------------------------------------- delivery challan (Rule 55) --

  api.get('/delivery-challans', async (req, res, next) => {
    try {
      const q = listQuery.parse(req.query);
      const { tenantId, userId } = req.session!;
      const forExport = q.format === 'csv' ? { ...q, limit: 5000, offset: 0 } : q;
      const page = await withTenant(tenantId, userId, db =>
        paged<Record<string, unknown>>(db, {
        from: `v_delivery_challan dc
                 left join eway_bill e on e.source_doc = 'dyeing_issue'
                                      and e.source_id = dc.issue_id and e.status <> 'cancelled'`,
        select: `dc.issue_id, dc.entry_no, dc.challan_no, dc.challan_date, dc.lot_no,
                 dc.consignee_name, dc.consignee_gstin, dc.pieces, dc.total_qty,
                 dc.taxable_value, dc.vehicle_no, dc.status,
                 e.ewb_no, e.our_ref as ewb_ref, e.valid_until as ewb_valid_until`,
        search: ['dc.challan_no', 'dc.consignee_name', 'dc.lot_no'],
        dateColumn: 'dc.challan_date',
        orderBy: 'dc.challan_date desc, dc.challan_no desc'
      }, forExport));
      if (q.format === 'csv') return sendCsv(res, 'delivery-challans', page.rows);
      res.json(page);
    } catch (e) { next(e); }
  });

  api.get('/delivery-challans/:id/print', async (req, res, next) => {
    try {
      const id = uuid.parse(req.params.id);
      const { tenantId, userId } = req.session!;
      const out = await withTenant(tenantId, userId, async db => {
        const head = await one<any>(db, 'select * from v_delivery_challan where issue_id = $1', [id]);
        if (!head) return null;
        const lines = await many<any>(
          db, 'select * from v_delivery_challan_line where issue_id = $1 order by sno', [id]);
        return { ...head, lines, amount_in_words: amountInWords(Number(head.taxable_value)) };
      });
      if (!out) return res.status(404).json({ error: 'delivery challan not found' });
      res.json(out);
    } catch (e) { next(e); }
  });

  // ----------------------------------------------------- e-way bill (Rule 138) --

  const ewayOptions = z.object({
    distanceKm: z.coerce.number().int().min(1).max(4000),
    transMode: z.enum(['1', '2', '3', '4']).default('1'),
    transporterGstin: z.string().max(15).nullish(),
    transporterName: z.string().max(120).nullish(),
    transDocNo: z.string().max(40).nullish(),
    transDocDate: isoDate.nullish(),
    vehicleNo: z.string().max(20).nullish(),
    vehicleType: z.enum(['R', 'O']).default('R')
  });

  api.post('/eway-bills/invoice/:id', requireWrite('sales'), async (req, res, next) => {
    try {
      const id = uuid.parse(req.params.id);
      const body = ewayOptions.parse(req.body);
      const out = await withCtx(req, ctx => ewayForInvoice(ctx, id, body));
      res.status(out.ok ? 201 : 422).json(out);
    } catch (e) { next(e); }
  });

  api.post('/eway-bills/challan/:id', requireWrite('store'), async (req, res, next) => {
    try {
      const id = uuid.parse(req.params.id);
      const body = ewayOptions.parse(req.body);
      const out = await withCtx(req, ctx => ewayForChallan(ctx, id, body));
      res.status(out.ok ? 201 : 422).json(out);
    } catch (e) { next(e); }
  });

  listRoute('/eway-bills', 'eway-bills', {
    from: 'eway_bill e',
    select: `e.id, e.our_ref, e.ewb_no, e.status, e.source_doc, e.source_id, e.doc_type,
             e.doc_no, e.doc_date, e.sub_supply_type, e.to_gstin, e.to_state_code,
             e.distance_km, e.vehicle_no, e.total_value, e.valid_until, e.last_error`,
    search: ['e.our_ref', 'e.doc_no', 'e.ewb_no', 'e.vehicle_no'],
    dateColumn: 'e.doc_date',
    orderBy: 'e.doc_date desc, e.created_at desc'
  });

  api.get('/eway-bills/:id/payload', async (req, res, next) => {
    try {
      const id = uuid.parse(req.params.id);
      const { tenantId, userId } = req.session!;
      const row = await withTenant(tenantId, userId, db =>
        one(db, 'select our_ref, payload, status, valid_until, last_error from eway_bill where id = $1',
          [id]));
      if (!row) return res.status(404).json({ error: 'e-way bill not found' });
      res.json(row);
    } catch (e) { next(e); }
  });

  api.post('/eway-bills/:id/cancel', requireWrite('sales'), async (req, res, next) => {
    try {
      const id = uuid.parse(req.params.id);
      const body = z.object({ reason: z.string().min(1).max(200) }).parse(req.body);
      const { tenantId, userId } = req.session!;
      const out = await withTenant(tenantId, userId, db =>
        one(db,
          `update eway_bill set status = 'cancelled', last_error = $2
            where id = $1 and status <> 'cancelled' returning our_ref, status`,
          [id, `cancelled: ${body.reason}`]));
      if (!out) return res.status(409).json({ error: 'already cancelled, or no such bill' });
      res.json(out);
    } catch (e) { next(e); }
  });

  // ---------------------------------------------------------------- ITC-04 --

  api.get('/itc04/:period', async (req, res, next) => {
    try {
      const quarter = z.string().regex(/^Q[1-4]-\d{4}$/).parse(req.params.period);
      const format = z.enum(['json', 'csv']).default('json').parse(req.query.format ?? 'json');
      const { tenantId, userId } = req.session!;
      const data = await withTenant(tenantId, userId, async db => {
        const [sent, received, pending] = await Promise.all([
          many<any>(db, 'select * from v_itc04_sent where return_period = $1 order by challan_date',
            [quarter]),
          many<any>(db, `select * from v_itc04_received where return_period = $1
                          order by original_challan_date`, [quarter]),
          many<any>(db, 'select * from v_itc04_pending order by days_out desc')
        ]);
        return { returnPeriod: quarter, sent, received, pending };
      });
      if (format === 'csv') {
        return sendCsv(res, `itc04-${quarter}`, [
          ...data.sent.map(r => ({ table: '4 (sent)', ...r })),
          ...data.received.map(r => ({ table: '5A (received)', ...r }))
        ]);
      }
      res.json(data);
    } catch (e) { next(e); }
  });

  // -------------------------------------------------------- return filings --

  api.get('/filings', async (req, res, next) => {
    try {
      const { tenantId, userId } = req.session!;
      const rows = await withTenant(tenantId, userId, db =>
        many(db, `select return_type, return_period, filed_at, arn
                    from gst_filing order by return_period desc, return_type`));
      res.json(rows);
    } catch (e) { next(e); }
  });

  /**
   * Marking a return filed freezes the period: an invoice inside it can no
   * longer be raised or cancelled, which is what the law already requires and
   * the system used to allow anyway.
   */
  api.post('/filings', requireWrite('accounts'), async (req, res, next) => {
    try {
      const body = z.object({
        returnType: z.enum(['GSTR1', 'GSTR3B', 'ITC04']),
        returnPeriod: z.string().regex(/^((0[1-9]|1[0-2])-\d{4}|Q[1-4]-\d{4})$/),
        arn: z.string().max(30).nullish()
      }).parse(req.body);
      const { tenantId, userId } = req.session!;
      const out = await withTenant(tenantId, userId, db =>
        one(db,
          `insert into gst_filing (tenant_id, return_type, return_period, filed_by, arn)
           values ($1,$2,$3,$4,$5) returning return_type, return_period, filed_at`,
          [tenantId, body.returnType, body.returnPeriod, userId, body.arn ?? null]));
      res.status(201).json(out);
    } catch (e) { next(e); }
  });

  api.delete('/filings/:type/:period', requireWrite('accounts'), async (req, res, next) => {
    try {
      if (req.session!.role !== 'owner') {
        return res.status(403).json({ error: 'only the owner may unlock a filed period' });
      }
      const type = z.enum(['GSTR1', 'GSTR3B', 'ITC04']).parse(req.params.type);
      const p = z.string().regex(/^((0[1-9]|1[0-2])-\d{4}|Q[1-4]-\d{4})$/).parse(req.params.period);
      const { tenantId, userId } = req.session!;
      const out = await withTenant(tenantId, userId, db =>
        one(db,
          `delete from gst_filing where return_type = $1 and return_period = $2
            returning return_type, return_period`, [type, p]));
      if (!out) return res.status(404).json({ error: 'that period is not marked filed' });
      res.json({ ...out, unlocked: true });
    } catch (e) { next(e); }
  });

  // --------------------------------------------------------------- reports --

  const REPORTS: Record<string, string> = {
    'barcode-history': 'v_barcode_history',
    'process-stock': 'v_process_stock',
    'po-pending': 'v_po_pending',
    'party-balance': 'v_party_balance',
    'stock-summary': 'v_stock_summary',
    shrinkage: 'v_shrinkage_by_process_house',
    'gstr1-b2b': 'v_gstr1_b2b',
    'gstr1-cdnr': 'v_gstr1_cdnr',
    'gstr1-hsn': 'v_gstr1_hsn',
    'gstr3b-outward': 'v_gstr3b_outward',
    'einvoice-pending': 'v_einvoice_pending',
    'itc-summary': 'v_itc_summary',
    'gst-liability': 'v_gst_liability',
    'receivable-ageing': 'v_receivable_ageing',
    'party-statement': 'v_party_statement',
    'trial-balance': 'v_trial_balance',
    'quality-margin': 'v_quality_margin',
    'weaver-scorecard': 'v_weaver_scorecard',
    'process-house-scorecard': 'v_process_house_scorecard',
    'gstr2b-reconciliation': 'v_gstr2b_reconciliation',
    'tds-summary': 'v_tds_summary',
    'stock-valuation': 'v_stock_valuation',
    'outstanding-sales': 'v_outstanding_sales',
    'outstanding-purchases': 'v_outstanding_purchases',
    'cash-book': 'v_cash_book',
    'piece-drift': 'v_piece_drift',
    'piece-lineage': 'v_piece_lineage',
    'regroup-imbalance': 'v_regroup_imbalance',
    'stock-count-variance': 'v_stock_count_variance',
    'stock-count-summary': 'v_stock_count_summary'
  };

  api.get('/reports/:name', async (req, res, next) => {
    try {
      const name = req.params.name ?? '';
      const view = REPORTS[name];
      if (!view) return res.status(404).json({ error: 'unknown report' });
      const q = z.object({
        limit: z.coerce.number().int().min(1).max(5000).default(500),
        offset: z.coerce.number().int().min(0).default(0),
        format: z.enum(['json', 'csv']).default('json')
      }).parse(req.query);
      const { tenantId, userId } = req.session!;
      // An export is the whole report; a screen only ever asks for a page of it.
      const limit = q.format === 'csv' ? 20000 : q.limit;
      const offset = q.format === 'csv' ? 0 : q.offset;
      const rows = await withTenant(tenantId, userId, db =>
        many<Record<string, unknown>>(db, `select * from ${view} limit $1 offset $2`,
          [limit, offset]));
      if (q.format === 'csv') return sendCsv(res, name, rows);
      res.json(rows);
    } catch (e) { next(e); }
  });

  // Last: its /:resource wildcard would otherwise shadow every route above.
  api.use('/', resourceRouter());

  return api;
}
