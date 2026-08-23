import { many, one, nextDocNumber, type Db } from './db.ts';
import { computeInvoice, invoicePostingLines, type TaxableLine } from './gst.ts';
import {
  buildEinvoicePayload, validateEinvoice,
  type EinvoiceInput, type EinvoiceParty
} from './einvoice.ts';
import type { Ctx } from './domain.ts';
import { approvalFor, holdVoucher, recordEvent, type Posting } from './approvals.ts';
import { brokerageAmount, brokerageFor, settings, stringSetting } from './config.ts';

/** The IRP is unreliable with non-ASCII text, so descriptions are folded first. */
const asciiOnly = (s: string) =>
  s.replace(/[\u2010-\u2015]/g, '-').replace(/[\u2018\u2019]/g, "'")
   .replace(/[\u201C\u201D]/g, '"').replace(/[^\x20-\x7E]/g, ' ')
   .replace(/\s+/g, ' ').trim();

/** Posting roles resolved once per document; ambiguity is now impossible. */
async function roles(ctx: Ctx) {
  const rows = await many<{ posting_role: string; id: string }>(
    ctx.db,
    'select posting_role, id from ledger_account where posting_role is not null'
  );
  const map = new Map(rows.map(r => [r.posting_role, r.id]));
  const need = (role: string) => {
    const id = map.get(role);
    if (!id) throw new Error(`no ledger is bound to the posting role "${role}"`);
    return id;
  };
  return {
    sales: need('sales_finish'),
    cgstOutput: need('cgst_output'),
    sgstOutput: need('sgst_output'),
    igstOutput: need('igst_output'),
    roundOff: need('round_off'),
    brokerageExpense: map.get('brokerage_expense') ?? null,
    brokerageAccrued: map.get('brokerage_accrued') ?? null
  };
}

interface DispatchRow {
  dispatch_id: string; party_id: string; challan_date: string;
  transport_id: string | null; lr_no: string | null; vehicle_no: string | null;
  default_broker_id: string | null;
}

/**
 * Raises a tax invoice against a dispatch. Quantities and rates come from the
 * dispatch lines, so an invoice can never disagree with what physically left.
 */
export async function raiseInvoiceForDispatch(
  ctx: Ctx,
  dispatchId: string,
  opts: { invoiceDate?: string; placeOfSupply?: string; distanceKm?: number } = {}
) {
  // Lock the dispatch first. Without it this was a check-then-act: two
  // concurrent requests both saw no invoice and both inserted, billing the
  // customer twice. A partial unique index backs this up in the database.
  const locked = await one<{ id: string }>(
    ctx.db, 'select id from dispatch where id = $1 for update', [dispatchId]
  );
  if (!locked) throw new Error('dispatch not found');

  const existing = await one<{ id: string; invoice_no: string }>(
    ctx.db,
    `select id, invoice_no from sales_invoice
      where dispatch_id = $1 and status <> 'cancelled'`,
    [dispatchId]
  );
  if (existing) throw new Error(`dispatch already invoiced as ${existing.invoice_no}`);

  const head = await one<DispatchRow>(
    ctx.db,
    `select d.id as dispatch_id, d.party_id, d.challan_date::text, d.transport_id,
            d.lr_no, d.vehicle_no, party.broker_id as default_broker_id
       from dispatch d
       join ledger_account party on party.id = d.party_id
      where d.id = $1`,
    [dispatchId]
  );
  if (!head) throw new Error('dispatch not found');

  // A linked order's broker is the contractual source. A direct dispatch falls
  // back to the customer's default broker. Mixing brokers on one invoice is
  // refused because one accrual cannot honestly be split by guesswork.
  const orderBrokers = await many<{ broker_id: string }>(ctx.db,
    `select distinct so.broker_id
       from dispatch_line dl
       join finish_sales_order_line sol on sol.id = dl.so_line_id
       join finish_sales_order so on so.id = sol.order_id
      where dl.dispatch_id = $1 and so.broker_id is not null`, [dispatchId]);
  if (orderBrokers.length > 1) {
    throw new Error('one dispatch contains sales orders with different brokers; split the dispatch before invoicing');
  }
  const brokerId = orderBrokers[0]?.broker_id ?? head.default_broker_id;

  const lines = await many<{
    piece_id: string; quality_id: string; hsn_code: string; quality_name: string;
    selvedge: string; qty: number; rate: number; gst_rate: number; uom: string;
  }>(
    ctx.db,
    `select dl.piece_id, q.id as quality_id, q.hsn_code, q.name as quality_name,
            q.selvedge_line as selvedge, dl.qty, dl.rate, h.gst_rate,
            case q.bill_by when 'meters' then 'MTR' when 'weight' then 'KGS' else 'PCS' end as uom
       from dispatch_line dl
       join piece p on p.id = dl.piece_id
       join quality q on q.id = p.quality_id
       join hsn_code h on h.tenant_id = q.tenant_id and h.code = q.hsn_code
      where dl.dispatch_id = $1
      order by dl.sno`,
    [dispatchId]
  );
  if (lines.length === 0) throw new Error('dispatch has no lines');

  const seller = await partyFor(ctx, null);
  const buyer = await partyFor(ctx, head.party_id);
  const placeOfSupply = opts.placeOfSupply ?? buyer.stateCode;

  const taxable: TaxableLine[] = lines.map((l, i) => ({
    sno: i + 1,
    pieceId: l.piece_id,
    qualityId: l.quality_id,
    hsnCode: l.hsn_code,
    description: asciiOnly(`${l.quality_name}${l.selvedge ? ` - ${l.selvedge}` : ''}`).slice(0, 100),
    qty: Number(l.qty),
    uom: l.uom,
    rate: Number(l.rate),
    gstRate: Number(l.gst_rate)
  }));

  const companySettings = await settings(ctx.db);
  const rounding = stringSetting(
    companySettings, 'invoice.rounding', ['nearest_rupee', 'none'] as const, 'nearest_rupee'
  );
  const computed = computeInvoice(
    seller.stateCode, placeOfSupply, { gstRegType: buyer.gstRegType }, taxable, { rounding }
  );
  const brokerageRule = await brokerageFor(
    ctx.db, brokerId, head.party_id, 'sales_invoice'
  );
  const brokerage = brokerageRule
    ? brokerageAmount(
        brokerageRule,
        computed.taxableValue,
        computed.lines.reduce((total, line) => total + Number(line.qty), 0)
      )
    : 0;

  const invoiceNo = await nextDocNumber(ctx.db, ctx.tenantId, 'sales_invoice', ctx.fy);
  const invoiceDate = opts.invoiceDate ?? head.challan_date;

  // Above the tenant's threshold the invoice is raised but not posted; a second
  // person releases it. Decided before the insert so the row lands with the
  // right status rather than being corrected afterwards.
  const approval = await approvalFor(ctx.db, 'sales_invoice', computed.invoiceTotal);

  const inv = await one<{ id: string }>(
    ctx.db,
    `insert into sales_invoice (tenant_id, invoice_no, invoice_date, party_id, dispatch_id,
       place_of_supply, supply_type, taxable_value, cgst_amount, sgst_amount, igst_amount,
       round_off, invoice_total, broker_id, brokerage_rule_id, brokerage_amount,
       brokerage_state, status, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$19,$18,$17) returning id`,
    [ctx.tenantId, invoiceNo, invoiceDate, head.party_id, dispatchId, placeOfSupply,
     computed.supplyType, computed.taxableValue, computed.cgstAmount, computed.sgstAmount,
     computed.igstAmount, computed.roundOff, computed.invoiceTotal,
     brokerage > 0 ? brokerId : null, brokerage > 0 ? brokerageRule?.id : null, brokerage,
     ctx.userId,
     approval ? 'pending_approval' : 'approved', brokerage > 0 ? 'accrued' : 'none']
  );
  if (!inv) throw new Error('invoice insert returned nothing');

  await ctx.db.query(
    `insert into sales_invoice_line (tenant_id, invoice_id, sno, piece_id, quality_id, hsn_code,
       description, qty, uom, rate, taxable_value, gst_rate, cgst_rate, cgst_amount,
       sgst_rate, sgst_amount, igst_rate, igst_amount, line_total)
     select $1, $2, x.sno, x.piece_id, x.quality_id, x.hsn_code, x.description, x.qty, x.uom,
            x.rate, x.taxable_value, x.gst_rate, x.cgst_rate, x.cgst_amount, x.sgst_rate,
            x.sgst_amount, x.igst_rate, x.igst_amount, x.line_total
       from unnest($3::smallint[], $4::uuid[], $5::uuid[], $6::text[], $7::text[], $8::numeric[],
                   $9::text[], $10::numeric[], $11::numeric[], $12::numeric[], $13::numeric[],
                   $14::numeric[], $15::numeric[], $16::numeric[], $17::numeric[], $18::numeric[],
                   $19::numeric[])
            as x(sno, piece_id, quality_id, hsn_code, description, qty, uom, rate, taxable_value,
                 gst_rate, cgst_rate, cgst_amount, sgst_rate, sgst_amount, igst_rate, igst_amount,
                 line_total)`,
    [
      ctx.tenantId, inv.id,
      computed.lines.map(l => l.sno),
      computed.lines.map(l => l.pieceId ?? null),
      computed.lines.map(l => l.qualityId),
      computed.lines.map(l => l.hsnCode),
      computed.lines.map(l => l.description),
      computed.lines.map(l => l.qty),
      computed.lines.map(l => l.uom),
      computed.lines.map(l => l.rate),
      computed.lines.map(l => l.taxableValue),
      computed.lines.map(l => l.gstRate),
      computed.lines.map(l => l.cgstRate),
      computed.lines.map(l => l.cgstAmount),
      computed.lines.map(l => l.sgstRate),
      computed.lines.map(l => l.sgstAmount),
      computed.lines.map(l => l.igstRate),
      computed.lines.map(l => l.igstAmount),
      computed.lines.map(l => l.lineTotal)
    ]
  );

  const led = await roles(ctx);
  const ledgers = { ...led, party: head.party_id };
  const postings: Posting[] = invoicePostingLines(computed, ledgers);
  if (brokerage > 0) {
    if (!brokerId || !led.brokerageExpense || !led.brokerageAccrued) {
      throw new Error('brokerage is due but its broker, expense or accrued posting role is not configured');
    }
    postings.push(
      { ledgerId: led.brokerageExpense, debit: brokerage },
      { ledgerId: led.brokerageAccrued, credit: brokerage }
    );
  }

  if (approval) {
    await holdVoucher(
      ctx, 'sales_invoice', inv.id, 'sales', invoiceDate, `Tax invoice ${invoiceNo}`,
      postings
    );
    await recordEvent(ctx, 'sales_invoice', inv.id, 'submitted', computed.invoiceTotal);
  } else {
    const voucherId = await postInvoiceVoucher(ctx, invoiceNo, invoiceDate, inv.id, postings);
    await ctx.db.query('update sales_invoice set voucher_id = $1 where id = $2', [voucherId, inv.id]);
  }

  // Build and self-validate the IRP payload now, so a bad master is caught here
  // rather than at the moment the truck is waiting to leave.
  const einvoiceInput = einvoiceInputFor(
    invoiceNo, invoiceDate, placeOfSupply, seller, buyer, computed, head, opts.distanceKm
  );
  const einvoice = buildEinvoicePayload(einvoiceInput);
  const issues = validateEinvoice(einvoiceInput);

  await ctx.db.query(
    `insert into gst_document (tenant_id, invoice_id, payload, filing_status, last_error,
                               eway_distance_km)
     values ($1,$2,$3,$4,$5,$6)`,
    [ctx.tenantId, inv.id, JSON.stringify(einvoice),
     issues.length === 0 ? 'ready' : 'invalid',
     issues.length === 0 ? null : issues.map(i => `${i.field}: ${i.problem}`).join('; '),
     opts.distanceKm ?? null]
  );

  return {
    id: inv.id,
    invoiceNo,
    supplyType: computed.supplyType,
    placeOfSupply,
    taxableValue: computed.taxableValue,
    cgst: computed.cgstAmount,
    sgst: computed.sgstAmount,
    igst: computed.igstAmount,
    roundOff: computed.roundOff,
    invoiceTotal: computed.invoiceTotal,
    brokerage,
    brokerId: brokerage > 0 ? brokerId : null,
    einvoiceReady: issues.length === 0,
    einvoiceIssues: issues,
    status: approval ? 'pending_approval' : 'approved',
    // The caller needs to know nothing has hit the ledger yet.
    awaitingApproval: approval
      ? { role: approval.role, threshold: approval.threshold }
      : null
  };
}

function einvoiceInputFor(
  invoiceNo: string, invoiceDate: string, placeOfSupply: string,
  seller: EinvoiceParty & { gstRegType: string },
  buyer: EinvoiceParty & { gstRegType: string },
  computed: ReturnType<typeof computeInvoice>,
  head: DispatchRow,
  distanceKm?: number
): EinvoiceInput {
  return {
    supplyType: computed.supplyType,
    isRcm: false,
    docNo: invoiceNo,
    docDate: invoiceDate,
    placeOfSupply,
    seller,
    buyer,
    items: computed.lines.map(l => ({
      slNo: l.sno,
      description: l.description,
      isService: false,
      hsnCode: l.hsnCode,
      qty: l.qty,
      unit: l.uom,
      unitPrice: l.rate,
      totalAmount: Math.round(l.qty * l.rate * 100) / 100,
      discount: l.discount ?? 0,
      assessableAmount: l.taxableValue,
      gstRate: l.gstRate,
      igstAmount: l.igstAmount,
      cgstAmount: l.cgstAmount,
      sgstAmount: l.sgstAmount,
      totalItemValue: l.lineTotal
    })),
    totals: {
      assessableValue: computed.taxableValue,
      cgst: computed.cgstAmount,
      sgst: computed.sgstAmount,
      igst: computed.igstAmount,
      roundOff: computed.roundOff,
      invoiceTotal: computed.invoiceTotal
    },
    ...(distanceKm
      ? {
          eway: {
            distanceKm,
            mode: '1' as const,
            docNo: head.lr_no,
            vehicleNo: head.vehicle_no,
            vehicleType: 'R' as const
          }
        }
      : {})
  };
}

async function postInvoiceVoucher(
  ctx: Ctx, invoiceNo: string, invoiceDate: string, invoiceId: string,
  postings: Posting[]
) {
  const drift = postings.reduce((n, p) => n + (p.debit ?? 0) - (p.credit ?? 0), 0);
  if (Math.abs(drift) > 0.005) {
    throw new Error(`invoice ${invoiceNo} would post out of balance by ${drift.toFixed(2)}`);
  }

  const no = await nextDocNumber(ctx.db, ctx.tenantId, 'voucher_sales', ctx.fy);
  const v = await one<{ id: string }>(
    ctx.db,
    `insert into voucher (tenant_id, voucher_no, voucher_type, voucher_date, narration,
                          source_doc, source_id, is_posted, created_by)
     values ($1,$2,'sales',$3,$4,'sales_invoice',$5,true,$6) returning id`,
    [ctx.tenantId, no, invoiceDate, `Tax invoice ${invoiceNo}`, invoiceId, ctx.userId]
  );
  if (!v) throw new Error('voucher insert returned nothing');

  await ctx.db.query(
    `insert into voucher_line (tenant_id, voucher_id, ledger_id, debit, credit)
     select $1, $2, x.ledger_id, x.debit, x.credit
       from unnest($3::uuid[], $4::numeric[], $5::numeric[]) as x(ledger_id, debit, credit)`,
    [ctx.tenantId, v.id,
     postings.map(p => p.ledgerId),
     postings.map(p => p.debit ?? 0),
     postings.map(p => p.credit ?? 0)]
  );
  return v.id;
}

/** `null` means the tenant itself, which is the seller on every outward supply. */
async function partyFor(ctx: Ctx, ledgerId: string | null): Promise<EinvoiceParty & { gstRegType: string }> {
  if (!ledgerId) {
    const t = await one<{
      legal_name: string; gstin: string; state_code: string;
      address1: string | null; address2: string | null;
      city: string | null; pincode: string | null;
      phone: string | null; email: string | null;
    }>(ctx.db,
      `select legal_name, gstin, state_code, address1, address2, city, pincode, phone, email
         from tenant where id = $1`,
      [ctx.tenantId]);
    if (!t) throw new Error('tenant not found');
    // Never invent a seller address: an invoice with a wrong one is a bad invoice.
    if (!t.address1 || !t.city || !t.pincode) {
      throw new Error(
        'the tenant has no registered address; set address1, city and pincode before invoicing'
      );
    }
    return {
      gstin: t.gstin,
      legalName: t.legal_name,
      address1: t.address1,
      address2: t.address2,
      location: t.city,
      pincode: t.pincode,
      stateCode: t.state_code,
      phone: t.phone,
      email: t.email,
      gstRegType: 'regular'
    };
  }

  const row = await one<{
    name: string; alias: string; gstin: string | null; gst_reg_type: string;
    line1: string | null; city: string | null; pincode: string | null; state_code: string | null;
  }>(ctx.db,
    `select la.name, la.alias, la.gstin, la.gst_reg_type,
            a.line1, a.city, a.pincode, a.state_code
       from ledger_account la
       left join lateral (
         select line1, city, pincode, state_code from ledger_address
          where ledger_id = la.id order by is_ship_to desc, is_primary desc limit 1
       ) a on true
      where la.id = $1`,
    [ledgerId]);
  if (!row) throw new Error('party not found');

  return {
    gstin: row.gstin,
    legalName: row.name,
    tradeName: row.alias || null,
    address1: row.line1 ?? '',
    location: row.city ?? '',
    pincode: row.pincode,
    stateCode: row.state_code ?? (row.gstin ? row.gstin.slice(0, 2) : ''),
    gstRegType: row.gst_reg_type
  };
}
