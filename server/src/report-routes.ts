import { Router } from 'express';
import { z } from 'zod';
import { many, one, withTenant, nextDocNumber } from './db.ts';
import { requireWrite } from './auth.ts';
import { amountInWords, round2 } from './money.ts';
import { ewayForChallan, ewayForInvoice } from './ewaybill.ts';
import { listQuery, paged, sendCsv, type ListSpec } from './listing.ts';
import { REPORTS, reportCatalogue, reportRows, reportTotals } from './reporting.ts';
import { renderReportPdf, renderLedgerConfirmationPdf } from './pdf.ts';
import { renderXlsx } from './xlsx.ts';
import { postVoucher } from './payments.ts';
import type { Ctx } from './domain.ts';

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

function fyLabel(d = new Date()) {
  const y = d.getFullYear();
  const start = d.getMonth() >= 3 ? y : y - 1;
  return `${start}-${String(start + 1).slice(2)}`;
}

export function operationalReportRouter() {
  const router = Router();

  const withCtx = <T>(req: any, fn: (ctx: Ctx) => Promise<T>) => {
    const { tenantId, userId } = req.session!;
    return withTenant(tenantId, userId, db => fn({ db, tenantId, userId, fy: fyLabel() }));
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

  // ------------------------------------------------- dashboard & statements --

  router.get('/dashboard', async (req, res, next) => {
    try {
      const { tenantId, userId } = req.session!;
      const data = await withTenant(tenantId, userId, async db => {
        const summary = await one<Record<string, number>>(db, 'select * from report_dashboard()');
        const trend = await many(db, 'select * from v_sales_trend');
        const debtors = await many(db, 'select * from v_top_debtors limit 10');
        return { summary, trend, topDebtors: debtors };
      });
      res.json(data);
    } catch (e) { next(e); }
  });

  const period = z.object({
    from: isoDate.optional(),
    to: isoDate.optional(),
    /** Ledger by ledger, or one line per accounting head. */
    view: z.enum(['details', 'summary']).default('details'),
    format: z.enum(['json', 'csv']).default('json')
  });

  interface StatementRow extends Record<string, unknown> {
    section: string; code: string; name: string;
    control_account: string; amount: number;
  }

  /**
   * A statement reads either way round: an accountant checking a figure wants
   * the ledger, an owner wants the head. Rolling up here rather than in a
   * second query keeps the two views arithmetically identical by construction.
   */
  const summarise = (rows: StatementRow[]): StatementRow[] => {
    const heads = new Map<string, StatementRow>();
    for (const row of rows) {
      const key = `${row.section}|${row.control_account}`;
      const seen = heads.get(key);
      if (seen) seen.amount = round2(seen.amount + Number(row.amount));
      else heads.set(key, { ...row, code: '', name: row.control_account,
                            amount: round2(Number(row.amount)) });
    }
    return [...heads.values()];
  };

  const viewOf = (rows: StatementRow[], view: 'details' | 'summary') =>
    view === 'summary' ? summarise(rows) : rows;

  /**
   * The Trading Account. Opening stock, what came in and the direct costs on
   * one side; sales and closing stock on the other. The balancing figure is
   * Gross Profit, and it is checked rather than asserted: the same figure
   * computed straight from direct income less direct expenses must agree, and
   * where it does not the difference is named.
   */
  router.get('/statements/trading', async (req, res, next) => {
    try {
      const q = period.parse(req.query);
      const to = q.to ?? new Date().toISOString().slice(0, 10);
      const from = q.from ?? `${fyLabel(new Date(to)).slice(0, 4)}-04-01`;
      const { tenantId, userId } = req.session!;

      const { sections, stock } = await withTenant(tenantId, userId, async db => ({
        sections: await many<StatementRow & { sub_control: string }>(
          db, 'select * from report_pl_sections($1::date, $2::date)', [from, to]),
        stock: await one<{ opening: number; purchases: number; consumed: number; closing: number }>(
          db, 'select * from report_stock_movement($1::date, $2::date)', [from, to])
      }));

      const of = (section: string) => sections.filter(r => r.section === section);
      const total = (section: string) =>
        round2(of(section).reduce((n, r) => n + Number(r.amount), 0));

      const opening = Number(stock?.opening ?? 0);
      const purchases = Number(stock?.purchases ?? 0);
      const consumed = Number(stock?.consumed ?? 0);
      const closing = Number(stock?.closing ?? 0);

      const sales = total('trading_income');
      // Cost of goods sold sits inside `consumed`; the rest of Direct Expenses
      // is a bill nobody capitalised, and it is a line of its own.
      const cogs = round2(of('trading_expense')
        .filter(r => /cost of goods/i.test(r.control_account))
        .reduce((n, r) => n + Number(r.amount), 0));
      const otherDirect = round2(total('trading_expense') - cogs);

      const grossProfit = round2(sales + closing - opening - purchases - otherDirect);
      // What left stock other than by sale — write-offs, shortage. Classified
      // indirect, so the perpetual figure excludes it and this one does not.
      const stockAdjustments = round2(consumed - cogs);
      const perpetual = round2(sales - cogs - otherDirect);

      const debit = [
        { section: 'opening_stock', code: '', name: 'Opening Stock',
          control_account: 'Stock', amount: opening },
        { section: 'purchases', code: '', name: 'Purchases and Processing',
          control_account: 'Stock', amount: purchases },
        ...viewOf(of('trading_expense').filter(r => !/cost of goods/i.test(r.control_account)),
                  q.view)
      ];
      const credit = [
        ...viewOf(of('trading_income'), q.view),
        { section: 'closing_stock', code: '', name: 'Closing Stock',
          control_account: 'Stock', amount: closing }
      ];

      if (q.format === 'csv') {
        return sendCsv(res, `trading-account-${from}-to-${to}`, [
          ...debit.map(r => ({ side: 'Dr', ...r })),
          { side: 'Dr', section: 'gross_profit', code: '', name: 'Gross Profit c/d',
            control_account: '', amount: grossProfit },
          ...credit.map(r => ({ side: 'Cr', ...r }))
        ]);
      }

      res.json({
        from, to, view: q.view, debit, credit,
        totals: {
          openingStock: opening, purchases, closingStock: closing,
          sales, costOfGoodsSold: cogs, otherDirectExpenses: otherDirect,
          grossProfit,
          grossProfitPct: sales > 0 ? round2((grossProfit * 100) / sales) : 0,
          debitTotal: round2(opening + purchases + otherDirect + grossProfit),
          creditTotal: round2(sales + closing),
          /** Goods that left stock other than by sale. */
          stockAdjustments,
          /** Zero on sound books: the two ways of reaching gross profit agree. */
          difference: round2(grossProfit - (perpetual - stockAdjustments))
        }
      });
    } catch (e) { next(e); }
  });

  router.get('/statements/profit-loss', async (req, res, next) => {
    try {
      const q = period.parse(req.query);
      const to = q.to ?? new Date().toISOString().slice(0, 10);
      const from = q.from ?? `${fyLabel(new Date(to)).slice(0, 4)}-04-01`;
      const { tenantId, userId } = req.session!;
      const rows = await withTenant(tenantId, userId, db =>
        many<StatementRow>(
          db, 'select * from report_profit_loss($1::date, $2::date)', [from, to]));

      const shown = viewOf(rows, q.view);
      if (q.format === 'csv') return sendCsv(res, `profit-loss-${from}-to-${to}`, shown);

      const total = (s: string) =>
        rows.filter(r => r.section === s).reduce((n, r) => n + Number(r.amount), 0);
      const income = total('income');
      const expense = total('expense');
      res.json({
        from, to, view: q.view, rows: shown,
        totals: { income, expense, netProfit: round2(income - expense) }
      });
    } catch (e) { next(e); }
  });

  router.get('/statements/balance-sheet', async (req, res, next) => {
    try {
      const q = period.parse(req.query);
      const asOn = q.to ?? new Date().toISOString().slice(0, 10);
      const { tenantId, userId } = req.session!;
      const rows = await withTenant(tenantId, userId, db =>
        many<StatementRow>(db, 'select * from report_balance_sheet($1::date)', [asOn]));

      const shown = viewOf(rows, q.view);
      if (q.format === 'csv') return sendCsv(res, `balance-sheet-as-on-${asOn}`, shown);

      const total = (s: string) =>
        rows.filter(r => r.section === s).reduce((n, r) => n + Number(r.amount), 0);
      const assets = total('asset');
      const liabilities = total('liability');
      const equity = total('equity');
      res.json({
        asOn, view: q.view, rows: shown,
        totals: {
          assets, liabilities, equity,
          // Zero on a healthy set of books; anything else is a posting defect.
          difference: Math.round((assets - liabilities - equity) * 100) / 100
        }
      });
    } catch (e) { next(e); }
  });

  /**
   * The letter sent to a party to agree a balance — the same period ledger,
   * laid out for them to sign back. An auditor asks for this at year end and
   * it is what settles an argument in March.
   */
  router.get('/ledger-confirmation', async (req, res, next) => {
    try {
      const q = z.object({
        ledgerId: uuid, from: isoDate, to: isoDate,
        format: z.enum(['json', 'pdf']).default('json')
      }).parse(req.query);
      if (q.to < q.from) return res.status(400).json({ error: '`to` falls before `from`' });
      const { tenantId, userId } = req.session!;

      const data = await withTenant(tenantId, userId, async db => ({
        party: await one<{ code: string; name: string; gstin: string | null }>(
          db, 'select code, name, gstin from ledger_account where id = $1', [q.ledgerId]),
        mill: await one<{ legal_name: string; gstin: string; address: string | null }>(
          db, `select legal_name, gstin,
                      concat_ws(', ', address1, address2, city, state_code, pincode)
                        as address
                 from tenant where id = $1`, [tenantId]),
        rows: await many<Record<string, unknown>>(
          db, 'select * from report_ledger($1::uuid, $2::date, $3::date)',
          [q.ledgerId, q.from, q.to])
      }));
      if (!data.party) return res.status(404).json({ error: 'no such ledger' });

      const opening = Number(data.rows[0]?.running_balance ?? 0);
      const closing = Number(data.rows[data.rows.length - 1]?.running_balance ?? opening);
      // Row 0 is the opening; adding it to the period's debits would double it.
      const moves = data.rows.slice(1);
      const sum = (k: string) => round2(moves.reduce((n, r) => n + Number(r[k] ?? 0), 0));
      const totals = { debit: sum('debit'), credit: sum('credit') };

      if (q.format === 'json') {
        return res.json({ party: data.party, from: q.from, to: q.to,
                          opening, closing, totals, rows: data.rows });
      }

      const pdf = renderLedgerConfirmationPdf({
        millName: data.mill?.legal_name ?? 'Link ERP',
        millGstin: data.mill?.gstin ?? '—',
        millAddress: data.mill?.address ?? '',
        partyName: data.party.name, partyCode: data.party.code,
        partyGstin: data.party.gstin,
        from: q.from, to: q.to, opening, closing, totals,
        lines: moves as any
      });
      const stem = `ledger-confirmation-${data.party.code}-${q.from}-to-${q.to}`
        .replace(/[^A-Za-z0-9._-]+/g, '-');
      res.setHeader('content-type', 'application/pdf');
      res.setHeader('content-disposition', `attachment; filename="${stem}.pdf"`);
      res.send(pdf);
    } catch (e) { next(e); }
  });

  // ------------------------------------------------------------- contra --

  /**
   * Cash to bank, bank to bank, cash drawn for wages. No party, nothing
   * bought or sold — booking it as a receipt or payment puts an invented
   * counterparty into somebody's ledger.
   */
  router.post('/contra-entries', requireWrite('accounts'), async (req, res, next) => {
    try {
      const body = z.object({
        entryDate: isoDate,
        fromLedgerId: uuid,
        toLedgerId: uuid,
        amount: z.coerce.number().positive().max(1e11),
        instrumentNo: z.string().max(40).nullish(),
        narration: z.string().max(300).default('')
      }).parse(req.body);
      if (body.fromLedgerId === body.toLedgerId) {
        return res.status(400).json({ error: 'money cannot move from an account to itself' });
      }

      const out = await withCtx(req, async ctx => {
        // Only the mill's own money: a contra against a supplier would be a
        // payment wearing the wrong name.
        const ends = await many<{ id: string; name: string; nature: string }>(
          ctx.db,
          `select la.id, la.name, ca.nature::text
             from ledger_account la
             join control_account ca on ca.id = la.control_account_id
            where la.id = any($1::uuid[])`,
          [[body.fromLedgerId, body.toLedgerId]]
        );
        if (ends.length !== 2) throw new Error('one of those accounts does not exist');
        const wrong = ends.filter(l => l.nature !== 'cash' && l.nature !== 'bank');
        if (wrong.length > 0) {
          throw new Error(
            `a contra moves the mill's own money: ${wrong.map(l => l.name).join(', ')} ` +
            'is not a cash or bank account'
          );
        }

        const entryNo = await nextDocNumber(ctx.db, ctx.tenantId, 'contra_entry', ctx.fy);
        const row = await one<{ id: string }>(
          ctx.db,
          `insert into contra_entry (tenant_id, entry_no, entry_date, from_ledger_id,
                                     to_ledger_id, amount, instrument_no, narration, created_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
          [ctx.tenantId, entryNo, body.entryDate, body.fromLedgerId, body.toLedgerId,
           body.amount, body.instrumentNo ?? null, body.narration, ctx.userId]
        );
        if (!row) throw new Error('contra insert returned nothing');

        const from = ends.find(l => l.id === body.fromLedgerId)!;
        const to = ends.find(l => l.id === body.toLedgerId)!;
        const voucherId = await postVoucher(
          ctx, 'contra', body.entryDate,
          body.narration || `${from.name} to ${to.name}`,
          'contra_entry', row.id,
          [
            { ledgerId: body.toLedgerId, debit: body.amount },
            { ledgerId: body.fromLedgerId, credit: body.amount }
          ]
        );
        await ctx.db.query('update contra_entry set voucher_id = $2 where id = $1',
          [row.id, voucherId]);
        return { id: row.id, entryNo, amount: body.amount, voucherId,
                 from: from.name, to: to.name };
      });
      res.status(201).json(out);
    } catch (e) { next(e); }
  });

  listRoute('/contra-entries', 'contra-entries', {
    from: 'v_contra_entry c',
    select: `c.id, c.entry_no, c.entry_date, c.from_code, c.from_account,
             c.to_code, c.to_account, c.amount, c.instrument_no, c.narration,
             c.status, c.voucher_no`,
    search: ['c.entry_no', 'c.from_account', 'c.to_account', 'c.instrument_no', 'c.narration'],
    dateColumn: 'c.entry_date',
    orderBy: 'c.entry_date desc, c.entry_no desc'
  });

  // ----------------------------------------------- delivery challan (Rule 55) --

  router.get('/delivery-challans', async (req, res, next) => {
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

  router.get('/delivery-challans/:id/print', async (req, res, next) => {
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

  router.post('/eway-bills/invoice/:id', requireWrite('sales'), async (req, res, next) => {
    try {
      const id = uuid.parse(req.params.id);
      const body = ewayOptions.parse(req.body);
      const out = await withCtx(req, ctx => ewayForInvoice(ctx, id, body));
      res.status(out.ok ? 201 : 422).json(out);
    } catch (e) { next(e); }
  });

  router.post('/eway-bills/challan/:id', requireWrite('store'), async (req, res, next) => {
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

  router.get('/eway-bills/:id/payload', async (req, res, next) => {
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

  router.post('/eway-bills/:id/cancel', requireWrite('sales'), async (req, res, next) => {
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

  router.get('/itc04/:period', async (req, res, next) => {
    try {
      const quarter = z.string().regex(/^Q[1-4]-\d{4}$/).parse(req.params.period);
      const format = z.enum(['json', 'csv']).default('json').parse(req.query.format ?? 'json');
      const { tenantId, userId } = req.session!;
      const data = await withTenant(tenantId, userId, async db => {
        const sent = await many<any>(db,
          'select * from v_itc04_sent where return_period = $1 order by challan_date', [quarter]);
        const received = await many<any>(db,
          `select * from v_itc04_received where return_period = $1
            order by original_challan_date`, [quarter]);
        const pending = await many<any>(db, 'select * from v_itc04_pending order by days_out desc');
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

  router.get('/filings', async (req, res, next) => {
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
  router.post('/filings', requireWrite('accounts'), async (req, res, next) => {
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

  router.delete('/filings/:type/:period', requireWrite('accounts'), async (req, res, next) => {
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

  /**
   * `format=json` answers with a bare array, which is what every existing
   * caller reads. Row count and column totals are their own request, because
   * a footer costs an aggregate over the whole report and most screens paging
   * through rows do not want to pay for it on every page.
   */
  const reportQuery = z.object({
    q: z.string().max(80).optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
    limit: z.coerce.number().int().min(1).max(5000).default(500),
    offset: z.coerce.number().int().min(0).default(0),
    format: z.enum(['json', 'csv', 'pdf', 'xlsx']).default('json'),
    /** Columns to print, in order; defaults to everything the view returns. */
    columns: z.string().max(600).optional()
  });

  const reportOr404 = (req: any, res: any) => {
    const name = req.params.name ?? '';
    const report = REPORTS[name];
    if (!report) {
      res.status(404).json({ error: 'unknown report' });
      return null;
    }
    return { name, report };
  };

  router.get('/report-catalogue', (_req, res) => res.json(reportCatalogue()));

  router.get('/reports/:name/summary', async (req, res, next) => {
    try {
      const found = reportOr404(req, res);
      if (!found) return;
      const q = reportQuery.parse(req.query);
      const { tenantId, userId } = req.session!;
      const out = await withTenant(tenantId, userId, db =>
        reportTotals(db, found.report, { ...q, format: 'json' }));
      res.json(out);
    } catch (e) { next(e); }
  });

  /** A page of rows is JSON; a file is the whole report, headed and totalled. */
  async function deliver(res: any, tenantId: string, userId: string, out: {
    format: 'csv' | 'pdf' | 'xlsx'; stem: string; title: string; period: string;
    filter: string | null; rows: Record<string, unknown>[];
    columns?: string; totals: Record<string, number>; totalRows: number;
    dateKeys?: string[];
    groupBy?: string;
    groups?: { label: string; rows: number; totals: Record<string, number> }[];
  }) {
    const keys = out.columns
      ? out.columns.split(',').map(c => c.trim()).filter(Boolean)
      : Object.keys(out.rows[0] ?? {}).filter(k => k !== 'tenant_id' && !k.endsWith('_id'));
    const picked = keys.length > 0
      ? out.rows.map(r => Object.fromEntries(keys.map(k => [k, r[k]])))
      : out.rows;
    const stem = `${out.stem}-${out.period}`.replace(/[^A-Za-z0-9._-]+/g, '-');
    if (out.format === 'csv') return sendCsv(res, stem, picked);

    if (out.format === 'xlsx') {
      /**
       * Types come from the report's own registry, not from sniffing values.
       * A column of GSTINs that happens to hold digits is still text, and a
       * money column that happens to be empty is still a number.
       */
      const dates = new Set(out.dateKeys ?? []);
      const book = renderXlsx(out.title, keys.map(key => ({
        key, label: humanise(key),
        type: key in out.totals ? 'number' as const
            : dates.has(key) ? 'date' as const : 'text' as const
      })), picked);
      res.setHeader('content-type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('content-disposition', `attachment; filename="${stem}.xlsx"`);
      return res.send(book);
    }

    const mill = await withTenant(tenantId, userId, db =>
      one<{ legal_name: string; gstin: string }>(
        db, 'select legal_name, gstin from tenant where id = $1', [tenantId]));
    const pdf = renderReportPdf({
      millName: mill?.legal_name ?? 'Link ERP',
      millGstin: mill?.gstin ?? '—',
      title: out.title, period: out.period, filter: out.filter,
      columns: keys.map(key => ({ key, label: humanise(key), right: key in out.totals })),
      rows: picked, totals: out.totals, totalRows: out.totalRows,
      // Subtotals only print where the grouping column is on the page.
      groupBy: out.groupBy && keys.includes(out.groupBy) ? out.groupBy : undefined,
      groups: out.groups
    });
    res.setHeader('content-type', 'application/pdf');
    res.setHeader('content-disposition', `attachment; filename="${stem}.pdf"`);
    res.send(pdf);
  }

  const today = () => new Date().toISOString().slice(0, 10);

  router.get('/reports/:name', async (req, res, next) => {
    try {
      const found = reportOr404(req, res);
      if (!found) return;
      const { name, report } = found;
      const q = reportQuery.parse(req.query);
      const { tenantId, userId } = req.session!;

      // A file is the whole report; a screen only ever asks for a page of it.
      const file = q.format !== 'json';
      const listing = { ...q, format: 'json' as const, ...(file ? { limit: 20000, offset: 0 } : {}) };
      const { rows, totals } = await withTenant(tenantId, userId, async db => ({
        rows: await reportRows(db, report, listing),
        totals: file ? await reportTotals(db, report, listing) : null
      }));
      if (!file || !totals) return res.json(rows);

      await deliver(res, tenantId, userId, {
        format: q.format as 'csv' | 'pdf' | 'xlsx',
        stem: name, title: report.title,
        period: report.dateColumn
          ? `${q.from ?? 'start'} to ${q.to ?? today()}`
          : `as on ${today()}`,
        filter: q.q ?? null, rows, columns: q.columns,
        totals: totals.totals, totalRows: totals.total,
        groupBy: report.groupBy, groups: totals.groups,
        // Any ISO date the view returns, so a spreadsheet gets a real date.
        dateKeys: Object.keys(rows[0] ?? {})
          .filter(k => /^\d{4}-\d{2}-\d{2}$/.test(String(rows[0]?.[k] ?? '')))
      });
    } catch (e) { next(e); }
  });

  /**
   * One ledger over one period, opening balance first. The party statement
   * view carries a running balance over all time and cannot be windowed: cut
   * it to a date range and the balance starts from nowhere.
   */
  router.get('/ledger', async (req, res, next) => {
    try {
      const q = z.object({
        ledgerId: uuid,
        from: isoDate,
        to: isoDate,
        format: z.enum(['json', 'csv', 'pdf', 'xlsx']).default('json'),
        columns: z.string().max(600).optional()
      }).parse(req.query);
      if (q.to < q.from) return res.status(400).json({ error: '`to` falls before `from`' });
      const { tenantId, userId } = req.session!;

      const { ledger, rows } = await withTenant(tenantId, userId, async db => ({
        ledger: await one<{ code: string; name: string }>(
          db, 'select code, name from ledger_account where id = $1', [q.ledgerId]),
        rows: await many<Record<string, unknown>>(
          db, 'select * from report_ledger($1::uuid, $2::date, $3::date)',
          [q.ledgerId, q.from, q.to])
      }));
      if (!ledger) return res.status(404).json({ error: 'no such ledger' });

      const opening = Number(rows[0]?.running_balance ?? 0);
      const closing = Number(rows[rows.length - 1]?.running_balance ?? opening);
      // Row 0 is the opening; adding it to the period's debits would double it.
      const moves = rows.slice(1);
      const sum = (k: string) => moves.reduce((n, r) => n + Number(r[k] ?? 0), 0);
      const totals = { debit: sum('debit'), credit: sum('credit') };

      if (q.format === 'json') {
        return res.json({ ledger, from: q.from, to: q.to, opening, closing, totals, rows });
      }
      await deliver(res, tenantId, userId, {
        format: q.format, stem: `ledger-${ledger.code}`,
        title: `Ledger — ${ledger.name}`, period: `${q.from} to ${q.to}`,
        filter: `Opening ${opening.toFixed(2)}   Closing ${closing.toFixed(2)}`,
        rows, columns: q.columns, totals, totalRows: rows.length
      });
    } catch (e) { next(e); }
  });

  return router;
}

/** Column labels for an export, from the key itself — the screens own the
 *  prettier ones and duplicating that map here would let the two drift. */
const humanise = (key: string) =>
  key.replaceAll('_', ' ').replace(/\b[a-z]/g, c => c.toUpperCase()).replace(/\bPct\b/, '%');
