import { Router } from 'express';
import { z } from 'zod';
import { many, one, withTenant, nextDocNumber } from './db.ts';
import { requireAuth, requireWrite } from './auth.ts';
import { identityRouter, publicAuthRouter } from './auth-routes.ts';
import { documentRouter } from './document-routes.ts';
import { resourceRouter } from './resources.ts';
import { postCutPack, type Ctx } from './domain.ts';
import { deductionFor, recordDeduction, closeFinancialYear, reopenFinancialYear } from './tds.ts';
import {
  recordPayment, suggestAllocation, cancelPayment, releaseBrokerageForPayment, forfeitBrokerage
} from './payments.ts';
import { postGreyReturn, postDyeingReturn, applyGreyReturn, applyDyeingReturn, applyCustomerReturn, postCustomerReturn } from './returns.ts';
import { postWriteOff, applyWriteOff } from './writeoff.ts';
import { cancelDocument } from './cancellation.ts';
import { listQuery, paged, sendCsv, type ListSpec } from './listing.ts';
import { operationalReportRouter } from './report-routes.ts';
import { approveDocument, rejectDocument } from './approvals.ts';
import { splitPiece, mergePieces, lineageOf } from './regroup.ts';
import { answerDeclaration, createPortalUser } from './portal.ts';
import {
  openCount, addScans, removeScan, exceptionsFor, submitCount, applyStockCount
} from './stockcount.ts';
import { configurationRouter } from './configuration.ts';
import { rateFor } from './config.ts';
import {
  listReconciliations, createReconciliation, getReconciliation,
  matchStatementLine, unmatchStatementLine, completeReconciliation, cancelReconciliation
} from './bank-reconciliation.ts';
import { applyReprocessReceipt } from './reprocess.ts';
import { millReadinessRouter } from './mill-readiness.ts';
import { onboardingRouter } from './onboarding.ts';
import { globalSearchRouter } from './global-search.ts';
import { commercialFoundationRouter } from './commercial-foundation.ts';
import { productionOperationsRouter } from './production-operations.ts';
import { attachmentRouter } from './attachments.ts';
import { platformRouter, publicPlatformRouter } from './platform.ts';
import { editionRouter } from './editions.ts';

const uuid = z.string().uuid();
const money = z.coerce.number().finite();
const qty = z.coerce.number().finite().nonnegative();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
const barcode = z.string().trim().min(1).max(40);

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

  api.use(publicAuthRouter());
  api.use(publicPlatformRouter());
  api.use(requireAuth);
  api.use('/configuration', configurationRouter());
  api.use(identityRouter());
  api.use(millReadinessRouter());
  api.use('/onboarding', onboardingRouter());
  api.use('/global-search', globalSearchRouter());
  api.use(commercialFoundationRouter());
  api.use(attachmentRouter());
  api.use(platformRouter());
  api.use(editionRouter());

  // ------------------------------------------------------------- documents --

  const withCtx = <T>(req: any, fn: (ctx: Ctx) => Promise<T>) => {
    const { tenantId, userId, activeLocationId } = req.session!;
    return withTenant(tenantId, userId, db => fn({
      db, tenantId, userId, activeLocationId, fy: fyLabel()
    }));
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
        for (const line of lines) {
          const bucket = byOrder.get(line.order_id);
          if (bucket) bucket.push(line); else byOrder.set(line.order_id, [line]);
        }
        return { ...page, rows: page.rows.map(order => ({
          ...order, lines: byOrder.get(order.id) ?? []
        })) };
      });
      if (q.format === 'csv') {
        return sendCsv(res, name, data.rows.map(({ lines: _lines, ...head }: any) => head));
      }
      res.json(data);
    } catch (e) { next(e); }
  });

  api.use(documentRouter());

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
          const contract = await rateFor(ctx.db, body.partyId, line.qualityId, 'sales', body.orderDate);
          if (!contract) throw new Error('no sales rate is entered and no valid rate contract matches one order line');
          resolvedLines.push({ ...line, rate: contract.rate });
        }
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

  orderListRoute('/sales-orders', 'sales-orders', {
    from: 'finish_sales_order o join ledger_account l on l.id = o.party_id',
    select: `o.id, o.order_no, o.order_date, o.status, o.delivery_date, o.destination,
             o.party_id, l.name as party_name`,
    search: ['o.order_no', 'l.name', 'o.destination'],
    dateColumn: 'o.order_date',
    orderBy: 'o.order_date desc, o.order_no desc'
  }, `select sl.order_id, sl.id, sl.sno, sl.pcs, sl.qty, sl.rate, sl.amount, sl.dispatched_qty,
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
    openingOutstandingId: uuid.nullish(),
    amount: money.positive()
  }).refine(value => [value.salesInvoiceId,value.purchaseInvoiceId,value.openingOutstandingId]
      .filter(Boolean).length === 1,
    'an allocation must name exactly one live or opening bill');
  const paymentDeduction = z.object({
    salesInvoiceId: uuid.nullish(),
    purchaseInvoiceId: uuid.nullish(),
    kind: z.enum(['cash_discount', 'quality_discount', 'rate_difference', 'shortage', 'tds', 'other']),
    amount: money.positive(),
    reason: z.string().trim().min(2).max(300),
    taxTreatment: z.enum(['none', 'credit_note_required', 'debit_note_required']).default('none')
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
        allocations: z.array(allocation).max(MAX_DOC_LINES).default([]),
        deductions: z.array(paymentDeduction).max(MAX_DOC_LINES).default([])
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

  api.post('/sales-invoices/:id/brokerage/forfeit', requireWrite('owner'), async (req, res, next) => {
    try {
      const id = uuid.parse(req.params.id);
      const body = z.object({ reason: z.string().trim().min(3).max(200),
        forfeitDate: isoDate.optional() }).parse(req.body);
      res.json(await withCtx(req, ctx => forfeitBrokerage(ctx, id, body.reason, body.forfeitDate)));
    } catch (e) { next(e); }
  });

  // ------------------------------------------------ bank reconciliation --

  api.get('/bank-reconciliations', async (req, res, next) => {
    try {
      const out = await withCtx(req, ctx => listReconciliations(ctx));
      res.json(out);
    } catch (e) { next(e); }
  });

  api.post('/bank-reconciliations', requireWrite('accounts'), async (req, res, next) => {
    try {
      const body = z.object({
        bankAccountId: uuid,
        statementFrom: isoDate,
        statementTo: isoDate,
        openingBalance: money,
        closingBalance: money,
        lines: z.array(z.object({
          txnDate: isoDate,
          valueDate: isoDate.nullish(),
          reference: z.string().trim().max(100).nullish(),
          description: z.string().trim().max(500).default(''),
          amount: money.refine(value => Math.abs(value) >= 0.005, 'amount cannot be zero')
        })).min(1).max(5000)
      }).parse(req.body);
      const out = await withCtx(req, ctx => createReconciliation(ctx, body));
      res.status(201).json(out);
    } catch (e) { next(e); }
  });

  api.get('/bank-reconciliations/:id', async (req, res, next) => {
    try {
      const id = uuid.parse(req.params.id);
      const out = await withCtx(req, ctx => getReconciliation(ctx, id));
      res.json(out);
    } catch (e) { next(e); }
  });

  api.post('/bank-reconciliations/:id/lines/:lineId/match', requireWrite('accounts'), async (req, res, next) => {
    try {
      const id = uuid.parse(req.params.id);
      const lineId = uuid.parse(req.params.lineId);
      const body = z.object({ paymentId: uuid }).parse(req.body);
      const out = await withCtx(req, ctx => matchStatementLine(ctx, id, lineId, body.paymentId));
      res.json(out);
    } catch (e) { next(e); }
  });

  api.post('/bank-reconciliations/:id/lines/:lineId/unmatch', requireWrite('accounts'), async (req, res, next) => {
    try {
      const id = uuid.parse(req.params.id);
      const lineId = uuid.parse(req.params.lineId);
      const out = await withCtx(req, ctx => unmatchStatementLine(ctx, id, lineId));
      res.json(out);
    } catch (e) { next(e); }
  });

  api.post('/bank-reconciliations/:id/complete', requireWrite('owner'), async (req, res, next) => {
    try {
      const id = uuid.parse(req.params.id);
      const out = await withCtx(req, ctx => completeReconciliation(ctx, id));
      res.json(out);
    } catch (e) { next(e); }
  });

  api.post('/bank-reconciliations/:id/cancel', requireWrite('accounts'), async (req, res, next) => {
    try {
      const id = uuid.parse(req.params.id);
      const out = await withCtx(req, ctx => cancelReconciliation(ctx, id));
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
        'customer_return', 'write_off', 'dyeing_reprocess', 'dyeing_reprocess_receipt', 'gst_note'
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
    'grey_return', 'dyeing_return', 'customer_return', 'write_off',
    'dyeing_reprocess_receipt']);

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
          kind === 'payment' ? ctx => releaseBrokerageForPayment(ctx, id).then(() => undefined)
            : kind === 'stock_count' ? ctx => applyStockCount(ctx, id).then(() => undefined)
            : kind === 'grey_return' ? ctx => applyGreyReturn(ctx, id)
            : kind === 'dyeing_return' ? ctx => applyDyeingReturn(ctx, id)
            : kind === 'customer_return' ? ctx => applyCustomerReturn(ctx, id).then(() => undefined)
            : kind === 'write_off' ? ctx => applyWriteOff(ctx, id)
            : kind === 'dyeing_reprocess_receipt' ? ctx => applyReprocessReceipt(ctx, id)
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

  api.get('/opening-balances/:label', async (req, res, next) => {
    try {
      const label = z.string().regex(/^\d{4}-\d{2}$/).parse(req.params.label);
      const { tenantId, userId } = req.session!;
      const rows = await withTenant(tenantId, userId, db => many(db,
        `select la.id as ledger_id, la.code, la.name, ca.name as control_account,
                ca.nature::text, coalesce(ob.debit, 0) as debit,
                coalesce(ob.credit, 0) as credit
           from ledger_account la
           join control_account ca on ca.id = la.control_account_id
           left join opening_balance ob
             on ob.ledger_id = la.id and ob.fy_label = $1
          where ca.nature not in ('income', 'expense') and la.is_active
          order by ca.name, la.code`,
        [label]
      ));
      res.json(rows);
    } catch (e) { next(e); }
  });

  api.post('/opening-balances/:label', requireWrite('accounts'), async (req, res, next) => {
    try {
      const label = z.string().regex(/^\d{4}-\d{2}$/).parse(req.params.label);
      const body = z.object({
        entries: z.array(z.object({
          ledgerId: uuid,
          debit: money.nonnegative().default(0),
          credit: money.nonnegative().default(0)
        })).max(5000)
      }).parse(req.body);
      for (const entry of body.entries) {
        if (entry.debit > 0 && entry.credit > 0) {
          return res.status(400).json({ error: 'an opening ledger cannot be both debit and credit' });
        }
      }
      const debitPaise = body.entries.reduce((n, e) => n + Math.round(e.debit * 100), 0);
      const creditPaise = body.entries.reduce((n, e) => n + Math.round(e.credit * 100), 0);
      if (debitPaise !== creditPaise) {
        return res.status(400).json({
          error: `opening balances are out by ₹${(Math.abs(debitPaise - creditPaise) / 100).toFixed(2)}`
        });
      }

      const { tenantId, userId } = req.session!;
      const out = await withTenant(tenantId, userId, async db => {
        const fy = await one<{ status: string; starts_on: string; ends_on: string }>(
          db,
          `select status, starts_on::text, ends_on::text
             from financial_year where label = $1 for update`,
          [label]
        );
        if (!fy) throw new Error(`financial year ${label} does not exist`);
        if (fy.status !== 'open') throw new Error(`financial year ${label} is ${fy.status}`);
        const posted = await one<{ n: number }>(db,
          `select count(*)::int as n from voucher
            where is_posted and voucher_date between $1 and $2`,
          [fy.starts_on, fy.ends_on]);
        if ((posted?.n ?? 0) > 0) {
          throw new Error(`opening balances for ${label} are locked after the first posted voucher; use an audited journal adjustment`);
        }

        const ids = [...new Set(body.entries.map(e => e.ledgerId))];
        if (ids.length !== body.entries.length) throw new Error('an opening ledger is listed more than once');
        if (ids.length > 0) {
          const valid = await many<{ id: string }>(db,
            `select la.id
               from ledger_account la join control_account ca on ca.id = la.control_account_id
              where la.id = any($1::uuid[]) and ca.nature not in ('income', 'expense')`,
            [ids]);
          if (valid.length !== ids.length) throw new Error('an opening ledger is missing or is a profit-and-loss account');
        }

        await db.query('delete from opening_balance where fy_label = $1', [label]);
        const nonzero = body.entries.filter(e => e.debit > 0 || e.credit > 0);
        if (nonzero.length > 0) {
          await db.query(
            `insert into opening_balance (tenant_id, fy_label, ledger_id, debit, credit)
             select $1, $2, x.ledger_id, x.debit, x.credit
               from unnest($3::uuid[], $4::numeric[], $5::numeric[])
                    as x(ledger_id, debit, credit)`,
            [tenantId, label, nonzero.map(e => e.ledgerId),
             nonzero.map(e => e.debit), nonzero.map(e => e.credit)]
          );
        }
        await db.query(
          `insert into opening_balance_revision
             (tenant_id, fy_label, created_by, total_debit, total_credit, entries)
           values ($1,$2,$3,$4,$5,$6::jsonb)`,
          [tenantId, label, userId, debitPaise / 100, creditPaise / 100,
           JSON.stringify(nonzero)]
        );
        return { fyLabel: label, ledgers: nonzero.length,
          totalDebit: debitPaise / 100, totalCredit: creditPaise / 100 };
      });
      res.json(out);
    } catch (e) { next(e); }
  });

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
                  p.grey_qty, p.finish_qty, p.current_qty, p.grey_weight_kg,
                  p.finish_weight_kg, p.current_weight_kg, q.width_cms,
                  case when p.current_qty > 0 and p.current_weight_kg is not null
                       then round(p.current_weight_kg*1000/p.current_qty,3) end as glm,
                  case when p.current_qty > 0 and p.current_weight_kg is not null and q.width_cms > 0
                       then round(p.current_weight_kg*100000/(p.current_qty*q.width_cms),3) end as gsm,
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

  // ------------------------------------------------------- process houses --

  api.get('/party-declarations', async (req, res, next) => {
    try {
      const q = z.object({
        state: z.enum(['submitted', 'accepted', 'rejected', 'all']).default('submitted')
      }).parse(req.query);
      const { tenantId, userId } = req.session!;
      const rows = await withTenant(tenantId, userId, db =>
        many(db,
          `select * from v_party_declaration_inbox
            where ($1::text = 'all' or state = $1::text)
            order by declared_at desc limit 500`,
          [q.state]));
      res.json(rows);
    } catch (e) { next(e); }
  });

  api.get('/party-declarations/:id', async (req, res, next) => {
    try {
      const id = uuid.parse(req.params.id);
      const { tenantId, userId } = req.session!;
      const out = await withTenant(tenantId, userId, async db => ({
        declaration: await one(db,
          'select * from v_party_declaration_inbox where declaration_id = $1', [id]),
        lines: await many(db,
          `select l.barcode, l.qty, l.reason, q.name as quality, p.lot_no, p.current_qty
             from party_declaration_line l
             left join piece p on p.id = l.piece_id
             left join quality q on q.id = p.quality_id
            where l.declaration_id = $1 order by l.barcode`, [id]),
        history: await many(db,
          `select e.state::text as state, e.note, e.created_at, u.full_name as actor
             from party_declaration_event e
             left join app_user u on u.id = e.actor_id
            where e.declaration_id = $1 order by e.id`, [id])
      }));
      if (!out.declaration) return res.status(404).json({ error: 'no such declaration' });
      res.json(out);
    } catch (e) { next(e); }
  });

  /**
   * Answering is a store decision: it is a statement about goods, not about
   * money, and the storekeeper is the person who knows whether four thaans
   * really did come back damaged.
   */
  api.post('/party-declarations/:id/:answer', requireWrite('store'), async (req, res, next) => {
    try {
      const id = uuid.parse(req.params.id);
      const answer = z.enum(['accept', 'reject']).parse(req.params.answer);
      const body = z.object({ note: z.string().max(300).default('') }).parse(req.body ?? {});
      const { tenantId, userId } = req.session!;
      const out = await withTenant(tenantId, userId, db =>
        answerDeclaration(
          { db, tenantId, userId }, id,
          answer === 'accept' ? 'accepted' : 'rejected', body.note
        ));
      res.json(out);
    } catch (e) { next(e); }
  });

  /** Giving a process house a login of its own, and taking it away again. */
  api.get('/portal-users', requireWrite('owner'), async (req, res, next) => {
    try {
      const { tenantId, userId } = req.session!;
      res.json(await withTenant(tenantId, userId, db =>
        many(db,
          `select p.user_id, u.email, u.full_name, u.is_active as account_active,
                  p.party_id, l.name as party, p.is_active, p.created_at
             from party_portal_user p
             join app_user u on u.id = p.user_id
             join ledger_account l on l.id = p.party_id
            order by l.name`)));
    } catch (e) { next(e); }
  });

  api.post('/portal-users', requireWrite('owner'), async (req, res, next) => {
    try {
      const body = z.object({
        email: z.string().email().max(120),
        fullName: z.string().trim().min(1).max(120),
        partyId: uuid,
        password: z.string().min(12).max(200)
      }).parse(req.body);
      const { tenantId, userId } = req.session!;
      const out = await withTenant(tenantId, userId, db =>
        createPortalUser({ db, tenantId, userId }, body));
      res.status(201).json(out);
    } catch (e) { next(e); }
  });

  api.post('/portal-users/:id/disable', requireWrite('owner'), async (req, res, next) => {
    try {
      const id = uuid.parse(req.params.id);
      const { tenantId, userId } = req.session!;
      const out = await withTenant(tenantId, userId, async db => {
        const gone = await db.query(
          'update party_portal_user set is_active = false where user_id = $1', [id]
        );
        if (gone.rowCount === 0) throw new Error('no such process-house login');
        return { userId: id, disabled: true };
      });
      res.json(out);
    } catch (e) { next(e); }
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

  api.use(operationalReportRouter());
  api.use(productionOperationsRouter());

  // Last: its /:resource wildcard would otherwise shadow every route above.
  api.use('/', resourceRouter());

  return api;
}
