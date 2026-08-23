import { Router } from 'express';
import { z } from 'zod';
import { many, one, withTenant } from './db.ts';
import { requireWrite } from './auth.ts';
import type { Ctx } from './domain.ts';
import { amountInWords } from './money.ts';
import {
  renderInvoiceBundlePdf, renderPartyStatementPdf,
  type InvoiceBundle, type PartyStatementBundle
} from './pdf.ts';

const uuid = z.string().uuid();
const money = z.coerce.number().finite().nonnegative();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

export interface ProcessBillInput {
  processHouseId: string;
  supplierBillNo: string;
  billDate: string;
  periodFrom?: string | null;
  periodTo?: string | null;
  billedMetres: number;
  billedAmount: number;
  remarks?: string;
  allocations: Array<{
    receiptLineId: string;
    allocatedMetres: number;
    allocatedAmount: number;
  }>;
}

export async function createProcessHouseBill(ctx: Ctx, input: ProcessBillInput) {
  const bill = await one<{ id: string }>(ctx.db,
    `insert into process_house_bill
       (tenant_id,process_house_id,supplier_bill_no,bill_date,period_from,period_to,
        billed_metres,billed_amount,remarks,created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
    [ctx.tenantId, input.processHouseId, input.supplierBillNo.trim(), input.billDate,
     input.periodFrom ?? null, input.periodTo ?? null, input.billedMetres,
     input.billedAmount, input.remarks ?? '', ctx.userId]);
  if (!bill) throw new Error('process-house bill insert returned nothing');

  if (input.allocations.length > 0) {
    await ctx.db.query(
      `insert into process_house_bill_allocation
         (tenant_id,bill_id,receipt_line_id,allocated_metres,allocated_amount)
       select $1,$2,x.receipt_line_id,x.metres,x.amount
         from unnest($3::uuid[],$4::numeric[],$5::numeric[])
              as x(receipt_line_id,metres,amount)`,
      [ctx.tenantId, bill.id, input.allocations.map(a => a.receiptLineId),
       input.allocations.map(a => a.allocatedMetres),
       input.allocations.map(a => a.allocatedAmount)]);
  }

  const reconciled = await one<Record<string, unknown>>(ctx.db,
    'select * from v_process_house_bill_reconciliation where bill_id=$1', [bill.id]);
  return reconciled;
}

export async function processReceiptBalances(ctx: Ctx, processHouseId?: string) {
  return many(ctx.db,
    `select rl.id as receipt_line_id, dr.entry_no as receipt_no, dr.entry_date,
            dr.process_house_id, h.name as process_house, p.barcode, q.name as quality,
            rl.received_qty, rl.received_weight_kg, rl.job_rate,
            round(rl.received_qty*rl.job_rate,2) as expected_amount,
            rl.received_qty-coalesce(sum(case when b.status<>'cancelled' then a.allocated_metres else 0 end),0)
              as unbilled_metres,
            round(rl.received_qty*rl.job_rate,2)-
              coalesce(sum(case when b.status<>'cancelled' then a.allocated_amount else 0 end),0)
              as unbilled_amount
       from dyeing_receipt_line rl
       join dyeing_receipt dr on dr.id=rl.receipt_id
       join ledger_account h on h.id=dr.process_house_id
       join piece p on p.id=rl.piece_id
       join quality q on q.id=p.quality_id
       left join process_house_bill_allocation a on a.receipt_line_id=rl.id
       left join process_house_bill b on b.id=a.bill_id
      where rl.active and ($1::uuid is null or dr.process_house_id=$1)
      group by rl.id,dr.entry_no,dr.entry_date,dr.process_house_id,h.name,p.barcode,q.name
     having rl.received_qty-coalesce(sum(case when b.status<>'cancelled' then a.allocated_metres else 0 end),0)>0.005
      order by dr.entry_date,dr.entry_no,p.barcode`, [processHouseId ?? null]);
}

export async function cancelProcessHouseBill(ctx: Ctx, billId: string, reason: string) {
  const row = await one<{ bill_id: string; supplier_bill_no: string; status: string }>(ctx.db,
    `update process_house_bill
        set status='cancelled',cancelled_at=now(),cancelled_by=$2,cancellation_reason=$3
      where id=$1 and status<>'cancelled'
      returning id as bill_id,supplier_bill_no,status`, [billId, ctx.userId, reason.trim()]);
  if (!row) throw new Error('active process-house bill not found');
  return row;
}

const xml = (value: unknown) => String(value ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&apos;');

export interface TallyVoucher {
  id: string;
  voucherNo: string;
  voucherType: string;
  voucherDate: string;
  narration: string;
  lines: Array<{ ledger: string; debit: number; credit: number }>;
}

export interface TallyLedger {
  name: string;
  parent: string;
  billWise?: boolean;
}

const tallyType = (type: string) => ({
  sales: 'Sales', purchase: 'Purchase', jobwork: 'Purchase',
  receipt: 'Receipt', payment: 'Payment', journal: 'Journal',
  credit_note: 'Credit Note', debit_note: 'Debit Note'
}[type] ?? 'Journal');

/** Produces import XML without making Tally-specific accounting guesses. */
export function buildTallyXml(company: string, vouchers: TallyVoucher[], ledgers: TallyLedger[] = []) {
  const masters = ledgers.map(ledger =>
    `<TALLYMESSAGE xmlns:UDF="TallyUDF"><LEDGER NAME="${xml(ledger.name)}" ACTION="Create">` +
    `<NAME>${xml(ledger.name)}</NAME><PARENT>${xml(ledger.parent)}</PARENT>` +
    `<ISBILLWISEON>${ledger.billWise ? 'Yes' : 'No'}</ISBILLWISEON>` +
    `</LEDGER></TALLYMESSAGE>`
  ).join('');
  const messages = vouchers.map(voucher => {
    const type = tallyType(voucher.voucherType);
    const entries = voucher.lines.map(line => {
      const isDebit = Number(line.debit) > 0;
      const amount = isDebit ? -Number(line.debit) : Number(line.credit);
      return `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${xml(line.ledger)}</LEDGERNAME>` +
        `<ISDEEMEDPOSITIVE>${isDebit ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>` +
        `<AMOUNT>${amount.toFixed(2)}</AMOUNT></ALLLEDGERENTRIES.LIST>`;
    }).join('');
    return `<TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER REMOTEID="${xml(voucher.id)}" ` +
      `VCHTYPE="${xml(type)}" ACTION="Create"><DATE>${xml(voucher.voucherDate.replaceAll('-', ''))}</DATE>` +
      `<VOUCHERTYPENAME>${xml(type)}</VOUCHERTYPENAME><VOUCHERNUMBER>${xml(voucher.voucherNo)}</VOUCHERNUMBER>` +
      `<NARRATION>${xml(voucher.narration)}</NARRATION>${entries}</VOUCHER></TALLYMESSAGE>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST>` +
    `</HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME><STATICVARIABLES>` +
    `<SVCURRENTCOMPANY>${xml(company)}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC>` +
    `<REQUESTDATA>${masters}${messages}</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
}

const tallyParent = (subControl: string) => ({
  'Inventory': 'Stock-in-Hand',
  'Bank': 'Bank Accounts',
  'Cash': 'Cash-in-Hand',
  'Direct Income': 'Direct Incomes',
  'Indirect Income': 'Indirect Incomes'
}[subControl] ?? subControl);

async function tallyExport(ctx: Ctx, from: string, to: string) {
  const tenant = await one<{ legal_name: string }>(ctx.db, 'select legal_name from tenant where id=$1', [ctx.tenantId]);
  if (!tenant) throw new Error('tenant not found');
  const rows = await many<{
    id: string; voucher_no: string; voucher_type: string; voucher_date: string;
    narration: string; ledger: string; debit: number; credit: number;
  }>(ctx.db,
    `select v.id,v.voucher_no,v.voucher_type::text,v.voucher_date::text,v.narration,
            l.name as ledger,vl.debit,vl.credit
       from voucher v join voucher_line vl on vl.voucher_id=v.id
       join ledger_account l on l.id=vl.ledger_id
      where v.is_posted and v.voucher_date between $1 and $2
      order by v.voucher_date,v.voucher_no,vl.id`, [from, to]);
  const grouped = new Map<string, TallyVoucher>();
  for (const row of rows) {
    const voucher = grouped.get(row.id) ?? {
      id: row.id, voucherNo: row.voucher_no, voucherType: row.voucher_type,
      voucherDate: row.voucher_date, narration: row.narration, lines: []
    };
    voucher.lines.push({ ledger: row.ledger, debit: Number(row.debit), credit: Number(row.credit) });
    grouped.set(row.id, voucher);
  }
  const ledgerRows = await many<{ name: string; sub_control: string; bill_wise: boolean }>(ctx.db,
    `select l.name,c.sub_control,
            c.nature in ('sundry_debtor_finish','sundry_creditor_grey',
                         'sundry_creditor_process','sundry_creditor_finish',
                         'sundry_creditor_brokerage','sundry_creditor_transport',
                         'sundry_creditor_expense') as bill_wise
       from ledger_account l join control_account c on c.id=l.control_account_id
      where l.is_active order by l.code`);
  return buildTallyXml(tenant.legal_name, [...grouped.values()], ledgerRows.map(row => ({
    name: row.name, parent: tallyParent(row.sub_control), billWise: row.bill_wise
  })));
}

interface NotificationRow {
  id: string; phone_e164: string; template_name: string; payload: Record<string, unknown>;
  attempts: number; source_doc: string; source_id: string;
}

const whatsappConfig = () => {
  const version = process.env.WHATSAPP_GRAPH_VERSION;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  return version && phoneNumberId && token ? { version, phoneNumberId, token } : null;
};

async function invoiceBundle(ctx: Ctx, invoiceId: string): Promise<InvoiceBundle> {
  const head = await one<any>(ctx.db,
    `select i.invoice_no,i.invoice_date::text,i.status::text,i.place_of_supply,i.supply_type::text,
            i.taxable_value,i.cgst_amount,i.sgst_amount,i.igst_amount,i.round_off,i.invoice_total,
            t.legal_name as mill_name,t.gstin as mill_gstin,
            concat_ws(', ',t.address1,t.address2,t.city,t.pincode) as mill_address,
            p.name as party_name,p.gstin as party_gstin,
            concat_ws(', ',pa.line1,pa.city,pa.pincode) as party_address,
            d.challan_no,d.challan_date::text,d.lr_no,d.lr_date::text,d.vehicle_no,
            tr.name as transporter,g.irn
       from sales_invoice i join tenant t on t.id=i.tenant_id
       join ledger_account p on p.id=i.party_id join dispatch d on d.id=i.dispatch_id
       left join ledger_account tr on tr.id=d.transport_id
       left join gst_document g on g.invoice_id=i.id
       left join lateral (select * from ledger_address where ledger_id=p.id
                           order by is_ship_to desc,is_primary desc limit 1) pa on true
      where i.id=$1`, [invoiceId]);
  if (!head) throw new Error('invoice not found');
  const lines = await many<any>(ctx.db,
    `select il.sno,il.description,il.hsn_code,p.barcode,p.grade_code,il.qty,il.uom,il.rate,
            il.taxable_value,il.gst_rate,il.cgst_amount,il.sgst_amount,il.igst_amount,
            il.line_total,p.current_weight_kg
       from sales_invoice_line il join piece p on p.id=il.piece_id
      where il.invoice_id=$1 order by il.sno`, [invoiceId]);
  return { ...head, lines, amount_in_words: amountInWords(Number(head.invoice_total)) };
}

async function partyStatement(ctx: Ctx, partyId: string, asOf: string): Promise<PartyStatementBundle> {
  const head = await one<any>(ctx.db,
    `select t.legal_name as mill_name,t.gstin as mill_gstin,
            concat_ws(', ',t.address1,t.address2,t.city,t.pincode) as mill_address,
            p.name as party_name,p.gstin as party_gstin,
            concat_ws(', ',pa.line1,pa.city,pa.pincode) as party_address
       from tenant t join ledger_account p on p.tenant_id=t.id
       left join lateral (select * from ledger_address where ledger_id=p.id
                           order by is_primary desc,is_ship_to desc limit 1) pa on true
      where t.id=$1 and p.id=$2`, [ctx.tenantId, partyId]);
  if (!head) throw new Error('party ledger not found');
  const lines = await many<any>(ctx.db,
    `select o.invoice_no,o.invoice_date::text,
            (o.invoice_date+coalesce(p.credit_days,0))::text as due_date,
            o.invoice_total,o.paid+o.credited as received_or_credited,o.outstanding,
            greatest(0,$2::date-o.invoice_date-coalesce(p.credit_days,0)) as overdue_days
       from v_outstanding_sales o join ledger_account p on p.id=o.party_id
      where o.party_id=$1 and o.outstanding>0.005 and o.invoice_date<=$2::date
      order by o.invoice_date,o.invoice_no`, [partyId, asOf]);
  if (lines.length === 0) throw new Error('party has no outstanding invoices as of that date');
  return {
    ...head, as_of: asOf, lines,
    total_outstanding: lines.reduce((sum, line) => sum + Number(line.outstanding), 0),
    total_overdue: lines.reduce((sum, line) => sum + (Number(line.overdue_days) > 0 ? Number(line.outstanding) : 0), 0)
  };
}

async function uploadWhatsAppPdf(config: NonNullable<ReturnType<typeof whatsappConfig>>, pdf: Buffer, filename: string) {
  const form = new FormData();
  form.set('messaging_product', 'whatsapp');
  form.set('type', 'application/pdf');
  form.set('file', new Blob([pdf], { type: 'application/pdf' }), filename);
  const response = await fetch(
    `https://graph.facebook.com/${encodeURIComponent(config.version)}/${encodeURIComponent(config.phoneNumberId)}/media`,
    { method: 'POST', headers: { authorization: `Bearer ${config.token}` }, body: form }
  );
  const body = await response.json() as any;
  if (!response.ok) throw new Error(body?.error?.message ?? `WhatsApp media upload returned ${response.status}`);
  if (!body?.id) throw new Error('WhatsApp accepted no media id');
  return String(body.id);
}

async function deliverWhatsApp(row: NotificationRow, pdf: Buffer, filename: string) {
  const config = whatsappConfig();
  if (!config) throw new Error('WhatsApp provider is not configured');
  const mediaId = await uploadWhatsAppPdf(config, pdf, filename);
  const parameters = Array.isArray(row.payload.parameters) ? row.payload.parameters : [];
  const response = await fetch(
    `https://graph.facebook.com/${encodeURIComponent(config.version)}/${encodeURIComponent(config.phoneNumberId)}/messages`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp', recipient_type: 'individual',
        to: row.phone_e164.replace(/^\+/, ''), type: 'template',
        template: {
          name: row.template_name,
          language: { code: String(row.payload.language ?? 'en') },
          components: [{ type: 'header', parameters: [{ type: 'document', document: {
            id: mediaId, filename
          } }] }, ...(parameters.length > 0 ? [{
            type: 'body', parameters: parameters.map(value => ({ type: 'text', text: String(value) }))
          }] : [])]
        }
      })
    }
  );
  const body = await response.json() as any;
  if (!response.ok) throw new Error(body?.error?.message ?? `WhatsApp returned ${response.status}`);
  const providerId = body?.messages?.[0]?.id;
  if (!providerId) throw new Error('WhatsApp accepted no message id');
  return String(providerId);
}

async function notificationDocument(ctx: Ctx, row: NotificationRow) {
  if (row.source_doc === 'sales_invoice') {
    const bundle = await invoiceBundle(ctx, row.source_id);
    return { pdf: renderInvoiceBundlePdf(bundle),
      filename: `${bundle.invoice_no.replace(/[^A-Za-z0-9._-]/g, '_')}.pdf` };
  }
  if (row.source_doc.startsWith('party_statement:')) {
    const asOf = String(row.payload.asOf ?? row.source_doc.slice('party_statement:'.length));
    const bundle = await partyStatement(ctx, row.source_id, asOf);
    return { pdf: renderPartyStatementPdf(bundle),
      filename: `outstanding-${bundle.party_name.replace(/[^A-Za-z0-9._-]/g, '_')}-${asOf}.pdf` };
  }
  throw new Error(`unsupported notification document ${row.source_doc}`);
}

export function millReadinessRouter() {
  const router = Router();
  const withCtx = <T>(req: any, fn: (ctx: Ctx) => Promise<T>) => {
    const { tenantId, userId } = req.session!;
    const now = new Date();
    const start = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
    return withTenant(tenantId, userId, db => fn({ db, tenantId, userId, fy: `${start}-${String(start + 1).slice(2)}` }));
  };

  router.get('/process-house-bills/available-receipts', async (req, res, next) => {
    try {
      const query = z.object({ processHouseId: uuid.optional() }).parse(req.query);
      res.json(await withCtx(req, ctx => processReceiptBalances(ctx, query.processHouseId)));
    } catch (error) { next(error); }
  });
  router.get('/process-house-bills', async (req, res, next) => {
    try {
      res.json(await withCtx(req, ctx => many(ctx.db,
        'select * from v_process_house_bill_reconciliation order by bill_date desc,supplier_bill_no desc')));
    } catch (error) { next(error); }
  });
  router.post('/process-house-bills', requireWrite('accounts'), async (req, res, next) => {
    try {
      const body = z.object({
        processHouseId: uuid, supplierBillNo: z.string().trim().min(1).max(80),
        billDate: isoDate, periodFrom: isoDate.nullish(), periodTo: isoDate.nullish(),
        billedMetres: money, billedAmount: money, remarks: z.string().max(500).default(''),
        allocations: z.array(z.object({ receiptLineId: uuid, allocatedMetres: money.positive(),
          allocatedAmount: money })).max(1000).default([])
      }).parse(req.body);
      res.status(201).json(await withCtx(req, ctx => createProcessHouseBill(ctx, body)));
    } catch (error) { next(error); }
  });
  router.post('/process-house-bills/:id/cancel', requireWrite('accounts'), async (req, res, next) => {
    try {
      const id = uuid.parse(req.params.id);
      const body = z.object({ reason: z.string().trim().min(2).max(200) }).parse(req.body);
      res.json(await withCtx(req, ctx => cancelProcessHouseBill(ctx, id, body.reason)));
    } catch (error) { next(error); }
  });

  router.get('/exports/tally.xml', async (req, res, next) => {
    try {
      const query = z.object({ from: isoDate, to: isoDate }).parse(req.query);
      const out = await withCtx(req, ctx => tallyExport(ctx, query.from, query.to));
      res.type('application/xml');
      res.setHeader('content-disposition', `attachment; filename="tally-${query.from}-${query.to}.xml"`);
      res.send(out);
    } catch (error) { next(error); }
  });

  router.get('/sales-invoices/:id/pdf', async (req, res, next) => {
    try {
      const id = uuid.parse(req.params.id);
      const bundle = await withCtx(req, ctx => invoiceBundle(ctx, id));
      const pdf = renderInvoiceBundlePdf(bundle);
      res.type('application/pdf');
      res.setHeader('content-disposition', `attachment; filename="${bundle.invoice_no.replace(/[^A-Za-z0-9._-]/g, '_')}.pdf"`);
      res.send(pdf);
    } catch (error) { next(error); }
  });

  router.get('/ledgers/:id/outstanding-statement.pdf', async (req, res, next) => {
    try {
      const id = uuid.parse(req.params.id);
      const asOf = isoDate.parse(req.query.asOf ?? new Date().toISOString().slice(0, 10));
      const bundle = await withCtx(req, ctx => partyStatement(ctx, id, asOf));
      const pdf = renderPartyStatementPdf(bundle);
      res.type('application/pdf');
      res.setHeader('content-disposition',
        `attachment; filename="outstanding-${bundle.party_name.replace(/[^A-Za-z0-9._-]/g, '_')}-${asOf}.pdf"`);
      res.send(pdf);
    } catch (error) { next(error); }
  });

  router.get('/notifications', async (req, res, next) => {
    try {
      const rows = await withCtx(req, ctx => many(ctx.db,
        `select id,kind,recipient_name,phone_e164,template_name,source_doc,source_id,state,
                attempts,next_attempt_at,provider_id,last_error,created_at,sent_at
           from notification_outbox order by created_at desc limit 500`));
      res.json({ providerConfigured: Boolean(whatsappConfig()), rows });
    } catch (error) { next(error); }
  });
  router.post('/notifications/invoices/:id', requireWrite('accounts'), async (req, res, next) => {
    try {
      const invoiceId = uuid.parse(req.params.id);
      const body = z.object({
        phoneE164: z.string().regex(/^\+[1-9][0-9]{7,14}$/).optional(),
        recipient: z.enum(['customer','broker']).default('customer')
      }).parse(req.body ?? {});
      const row = await withCtx(req, async ctx => {
        const invoice = await one<{
          invoice_no: string; invoice_date: string; invoice_total: number;
          party_name: string; party_mobile: string | null;
          broker_name: string | null; broker_mobile: string | null;
        }>(ctx.db,
          `select i.invoice_no,i.invoice_date::text,i.invoice_total,
                  p.name as party_name,p.mobile_e164 as party_mobile,
                  b.name as broker_name,b.mobile_e164 as broker_mobile
             from sales_invoice i join ledger_account p on p.id=i.party_id
             left join ledger_account b on b.id=i.broker_id
            where i.id=$1 and i.status='approved'`, [invoiceId]);
        if (!invoice) throw new Error('approved invoice not found');
        const recipientName = body.recipient === 'broker' ? invoice.broker_name : invoice.party_name;
        const phone = body.phoneE164 ?? (body.recipient === 'broker' ? invoice.broker_mobile : invoice.party_mobile);
        if (!recipientName) throw new Error('invoice has no broker');
        if (!phone) throw new Error(`${body.recipient} ledger has no WhatsApp number in +country-code format`);
        return one(ctx.db,
          `insert into notification_outbox
             (tenant_id,kind,recipient_name,phone_e164,template_name,payload,source_doc,source_id)
           values ($1,'invoice',$2,$3,$4,$5,'sales_invoice',$6)
           on conflict (tenant_id,kind,source_doc,source_id,phone_e164)
           do update set state=case when notification_outbox.state='sent' then notification_outbox.state else 'pending' end,
                         next_attempt_at=case when notification_outbox.state='sent' then notification_outbox.next_attempt_at else now() end,
                         last_error=case when notification_outbox.state='sent' then notification_outbox.last_error else null end
           returning id,state,phone_e164`,
          [ctx.tenantId, recipientName, phone,
           process.env.WHATSAPP_INVOICE_TEMPLATE ?? 'invoice_ready',
           JSON.stringify({ language: process.env.WHATSAPP_TEMPLATE_LANGUAGE ?? 'en',
             parameters: [recipientName, invoice.invoice_no, invoice.invoice_date,
               Number(invoice.invoice_total).toFixed(2)] }), invoiceId]);
      });
      res.status(201).json(row);
    } catch (error) { next(error); }
  });
  router.post('/notifications/reminders/:partyId', requireWrite('accounts'), async (req, res, next) => {
    try {
      const partyId = uuid.parse(req.params.partyId);
      const body = z.object({
        asOf: isoDate.default(new Date().toISOString().slice(0, 10)),
        phoneE164: z.string().regex(/^\+[1-9][0-9]{7,14}$/).optional()
      }).parse(req.body ?? {});
      const row = await withCtx(req, async ctx => {
        const statement = await partyStatement(ctx, partyId, body.asOf);
        const party = await one<{ mobile_e164: string | null }>(ctx.db,
          'select mobile_e164 from ledger_account where id=$1 and is_active', [partyId]);
        const phone = body.phoneE164 ?? party?.mobile_e164;
        if (!phone) throw new Error('party ledger has no WhatsApp number in +country-code format');
        const sourceDoc = `party_statement:${body.asOf}`;
        return one(ctx.db,
          `insert into notification_outbox
             (tenant_id,kind,recipient_name,phone_e164,template_name,payload,source_doc,source_id)
           values ($1,'payment_reminder',$2,$3,$4,$5,$6,$7)
           on conflict (tenant_id,kind,source_doc,source_id,phone_e164)
           do update set state=case when notification_outbox.state='sent' then notification_outbox.state else 'pending' end,
                         next_attempt_at=case when notification_outbox.state='sent' then notification_outbox.next_attempt_at else now() end,
                         last_error=case when notification_outbox.state='sent' then notification_outbox.last_error else null end
           returning id,state,phone_e164`,
          [ctx.tenantId, statement.party_name, phone,
           process.env.WHATSAPP_PAYMENT_REMINDER_TEMPLATE ?? 'payment_reminder',
           JSON.stringify({ language: process.env.WHATSAPP_TEMPLATE_LANGUAGE ?? 'en', asOf: body.asOf,
             parameters: [statement.party_name, Number(statement.total_outstanding).toFixed(2), body.asOf] }),
           sourceDoc, partyId]);
      });
      res.status(201).json(row);
    } catch (error) { next(error); }
  });
  router.post('/notifications/:id/cancel', requireWrite('accounts'), async (req, res, next) => {
    try {
      const id = uuid.parse(req.params.id);
      const row = await withCtx(req, ctx => one(ctx.db,
        `update notification_outbox set state='cancelled'
          where id=$1 and state in ('pending','failed') returning id,state`, [id]));
      if (!row) return res.status(409).json({ error: 'only a pending or failed notification can be cancelled' });
      res.json(row);
    } catch (error) { next(error); }
  });
  router.post('/notifications/:id/send', requireWrite('accounts'), async (req, res, next) => {
    try {
      if (!whatsappConfig()) return res.status(503).json({ error: 'WhatsApp provider is not configured' });
      const id = uuid.parse(req.params.id);
      const { tenantId, userId } = req.session!;
      const claimed = await withTenant(tenantId, userId, db => one<NotificationRow>(db,
        `update notification_outbox set state='sending',attempts=attempts+1
          where id=$1 and state in ('pending','failed') and next_attempt_at<=now()
          returning id,phone_e164,template_name,payload,attempts,source_doc,source_id`, [id]));
      if (!claimed) return res.status(409).json({ error: 'notification is not ready to send' });
      try {
        const document = await withTenant(tenantId, userId, db => notificationDocument(
          { db, tenantId, userId, fy: `${new Date().getFullYear()}-${String(new Date().getFullYear() + 1).slice(2)}` }, claimed));
        const providerId = await deliverWhatsApp(claimed, document.pdf, document.filename);
        await withTenant(tenantId, userId, db => db.query(
          `update notification_outbox set state='sent',provider_id=$2,sent_at=now(),last_error=null where id=$1`,
          [id, providerId]));
        res.json({ id, state: 'sent', providerId });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const seconds = Math.min(3600, 30 * (2 ** Math.min(claimed.attempts, 7)));
        await withTenant(tenantId, userId, db => db.query(
          `update notification_outbox set state='failed',last_error=$2,
                  next_attempt_at=now()+($3::text||' seconds')::interval where id=$1`,
          [id, message.slice(0, 1000), seconds]));
        res.status(502).json({ error: message, state: 'failed' });
      }
    } catch (error) { next(error); }
  });

  return router;
}
